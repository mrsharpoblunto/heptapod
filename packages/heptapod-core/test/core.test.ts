import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { removeReviewRun, resolveReviewNarrativePath, resolveReviewRunDirectory } from "../src/tool/cache.js";
import {
  beginReviewIngestion,
  deleteReview,
  failReviewIngestion,
  getReview,
  resolveDatabasePath,
  updateReviewIngestion,
} from "../src/tool/database.js";
import { extractGitHubEvidence } from "../src/tool/github.js";
import { splitPatchFiles } from "../src/tool/patch.js";

const directories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("persists pending ingestion progress, failures, and cleanup", () => {
  const root = temporaryDirectory("heptapod-state-");
  const databasePath = join(root, "reviews.sqlite");
  beginReviewIngestion("42", {
    title: "Pending review",
    summary: "Running tests",
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
  }, databasePath);
  assert.equal(getReview("42", databasePath)?.status, "pending");
  updateReviewIngestion("42", "Running tests after step 2/4", databasePath);
  assert.equal(getReview("42", databasePath)?.progress, "Running tests after step 2/4");
  failReviewIngestion("42", "Test runner failed", databasePath);
  assert.equal(getReview("42", databasePath)?.error, "Test runner failed");
  assert.equal(deleteReview("42", databasePath), true);
  assert.equal(getReview("42", databasePath), null);

  const previousRoot = process.env.HEPTAPOD_ROOT;
  try {
    process.env.HEPTAPOD_ROOT = root;
    const runDirectory = resolveReviewRunDirectory("42");
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, "narrative.json"), "{}\n");
    assert.equal(removeReviewRun("42"), true);
    assert.equal(existsSync(runDirectory), false);
  } finally {
    if (previousRoot === undefined) delete process.env.HEPTAPOD_ROOT;
    else process.env.HEPTAPOD_ROOT = previousRoot;
  }
});

test("extracts GitHub-hosted PR evidence without unrelated status images", () => {
  const attachment = "https://github.com/user-attachments/assets/12345678-abcd-1234-abcd-123456789abc";
  const videoAttachment = "https://github.com/user-attachments/assets/87654321-dcba-4321-dcba-cba987654321";
  const evidence = extractGitHubEvidence([
    `## Test plan\n\n${attachment}\n\n${videoAttachment}\n\n![CI](https://example.com/status.svg)`,
    `![Conversation result](${attachment})`,
  ], "https://github.com/example/repo/pull/42", [
    `<details><span class="m-1">walkthrough.mov</span><video src="https://private-user-images.githubusercontent.com/1/2-${videoAttachment.split("/").at(-1)}.mov?jwt=token"></video></details>`,
  ]);
  assert.deepEqual(evidence, [
    { url: attachment, label: "Conversation result", kind: "image", sourceUrl: "https://github.com/example/repo/pull/42" },
    { url: videoAttachment, label: "walkthrough.mov", kind: "video", sourceUrl: "https://github.com/example/repo/pull/42" },
  ]);
});

test("defaults review storage to the repository-local npm cache", () => {
  const root = temporaryDirectory("heptapod-root-");
  const previousRoot = process.env.HEPTAPOD_ROOT;
  try {
    process.env.HEPTAPOD_ROOT = root;
    assert.equal(resolveDatabasePath(), join(root, "node_modules", ".cache", "heptapod", "reviews.sqlite"));
    assert.equal(resolveReviewRunDirectory("42"), join(root, "node_modules", ".cache", "heptapod", "runs", "42"));
    assert.equal(resolveReviewNarrativePath("42"), join(root, "node_modules", ".cache", "heptapod", "runs", "42", "narrative.json"));
  } finally {
    if (previousRoot === undefined) delete process.env.HEPTAPOD_ROOT;
    else process.env.HEPTAPOD_ROOT = previousRoot;
  }
});

test("binary patches and quoted Git paths retain their file identity", () => {
  const patch = [
    "diff --git \"a/asset weird\\tname.bin\" \"b/asset weird\\tname.bin\"",
    "new file mode 100644",
    "index 0000000..1234567",
    "GIT binary patch",
    "literal 4",
    "LcmZQzWMT#Y01f~L",
    "",
  ].join("\n");
  assert.equal(splitPatchFiles(patch)[0].path, "asset weird\tname.bin");
});
