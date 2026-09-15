import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getReview } from "@thestraylight/heptapod-core/database";
import { apiUrl } from "../dist/tool/client.js";
import { renderIngestionProgress, renderPullRequestSelector } from "../dist/tool/tui.js";

function pullRequest(number) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    createdAt: `2026-09-${String(number).padStart(2, "0")}T00:00:00Z`,
    metadata: { login: "user", avatarUrl: "https://example.com/avatar", profileUrl: "https://github.com/user", state: "open" },
    baseRevision: "1".repeat(40),
    headRevision: "2".repeat(40),
    additions: 1,
    deletions: 0,
  };
}

test("the pull request selector keeps a ten-row viewport and accents interactive state", () => {
  const output = renderPullRequestSelector(
    Array.from({ length: 12 }, (_, index) => pullRequest(index + 1)),
    new Set([12]),
    11,
    { selectedCount: 1, loadingMore: true, frame: 2 },
    80,
  );
  assert.doesNotMatch(output, /#1 Pull request 1\n/);
  assert.doesNotMatch(output, /#2 Pull request 2\n/);
  assert.match(output, /#3 Pull request 3/);
  assert.ok(output.includes("\x1b[1mHeptapod\x1b[22m"));
  assert.ok(output.includes("\x1b[38;2;125;211;252m›\x1b[39m [\x1b[38;2;125;211;252mx\x1b[39m] #12"));
  assert.ok(output.includes("\x1b[38;2;125;211;252m⠹\x1b[39m 1 selected"));
  assert.doesNotMatch(output, /loaded · scroll down/);
  assert.doesNotMatch(renderPullRequestSelector([pullRequest(1)], new Set(), 0, { selectedCount: 0 }, 80), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test("the ingestion view renders live steps and terminal review results", () => {
  const requests = [pullRequest(1), pullRequest(2), pullRequest(3), pullRequest(4)];
  const output = renderIngestionProgress([
    { pullRequest: requests[0], state: "complete", message: "Complete", url: "http://localhost:49731/repositories/example/reviews/1" },
    { pullRequest: requests[1], state: "running", message: "Running tests after step 2/4" },
    { pullRequest: requests[2], state: "failed", message: "Tests failed" },
    { pullRequest: requests[3], state: "pending", message: "Waiting" },
  ], 2, 100);
  assert.ok(output.includes("\x1b[38;2;74;222;128m✓\x1b[39m #1"));
  assert.match(output, /Complete.*http:\/\/localhost:49731\/repositories\/example\/reviews\/1/);
  assert.ok(output.includes("\x1b[38;2;125;211;252mhttp://localhost:49731/repositories/example/reviews/1\x1b[39m"));
  assert.ok(output.includes("\x1b[38;2;125;211;252m⠹\x1b[39m #2"));
  assert.match(output, /Running tests after step 2\/4/);
  assert.ok(output.includes("\x1b[38;2;148;163;184mRunning tests after step 2/4\x1b[39m"));
  assert.ok(output.includes("\x1b[38;2;248;113;113m✕\x1b[39m #3"));
  assert.match(output, /Failed.*Tests failed/);
  assert.ok(output.includes("· #4 Pull request 4\n  \x1b[38;2;148;163;184mWaiting\x1b[39m"));
});

test("a command can target a development site's web port without changing user configuration", () => {
  assert.equal(apiUrl(undefined, "3000"), "http://localhost:3000/api/service");
  assert.throws(() => apiUrl("http://127.0.0.1:4001", "3000"), /only one/);
  assert.throws(() => apiUrl(undefined, "65536"), /service-port/);
});

test("capture prints the metadata directory and persists a preparing review through core", () => {
  const root = mkdtempSync(join(tmpdir(), "heptapod-cli-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    writeFileSync(join(root, "sample.txt"), "before\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "sample.txt"), "after\n"); git("add", "."); git("commit", "-qm", "head");
    const databasePath = join(root, "reviews.sqlite");
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("../dist/tool/cli.js", import.meta.url)), "capture", "--rev", `${base}...HEAD`], { cwd: root, env: { ...process.env, HEPTAPOD_ROOT: root, HEPTAPOD_DB: databasePath }, encoding: "utf8" });
    const captured = JSON.parse(output.slice(output.indexOf("{")));
    assert.equal(captured.metadataDirectory, join(root, "node_modules/.cache/heptapod/runs", captured.id));
    assert.equal(captured.narrative, join(captured.metadataDirectory, "narrative.json"));
    assert.equal(getReview(captured.id, databasePath)?.status, "preparing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
