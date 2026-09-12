import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { captureNarrative } from "../src/tool/capture.js";
import { removeReviewRun, resolveReviewNarrativePath, resolveReviewRunDirectory } from "../src/tool/cache.js";
import {
  beginReviewIngestion,
  deleteReview,
  failReviewIngestion,
  getReview,
  listReviews,
  resolveDatabasePath,
  updateReviewIngestion,
} from "../src/tool/database.js";
import { DIFF_ARGS, repositoryRoot } from "../src/tool/git.js";
import { extractGitHubEvidence } from "../src/tool/github.js";
import { ingestNarrative } from "../src/tool/ingest.js";
import { loadManifest } from "../src/tool/manifest.js";
import { splitPatchFiles } from "../src/tool/patch.js";
import { executeNarrativeTests } from "../src/tool/test-execution.js";
import type { NarrativeManifest, TestAreaChange } from "../src/tool/types.js";
import { verifyNarrative } from "../src/tool/verify.js";

function git(repo: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repo });
}

function makeRepository(): { repo: string; base: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-test-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "src", "math.js"), "export const add = (a, b) => a + b;\n");
  writeFileSync(join(repo, "app.js"), "import { add } from './src/math.js';\nconsole.log(add(1, 2));\n");
  writeFileSync(join(repo, "test", "math.test.js"), "import { add } from '../src/math.js';\nit('keeps arithmetic stable', () => console.assert(add(1, 2) === 3));\nit('covers legacy behavior', () => console.assert(add(0, 0) === 0));\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD").toString("utf8").trim();

  writeFileSync(join(repo, "test", "math.test.js"), "import { add, clamp } from '../src/math.js';\nit('keeps arithmetic stable', () => console.assert(add(2, 2) === 4));\nit('caps values above max', () => console.assert(clamp(12, 0, 10) === 10));\n");
  writeFileSync(join(repo, "src", "math.js"), "export const add = (a, b) => a + b;\nexport const clamp = (value, min, max) => Math.min(max, Math.max(min, value));\n");
  writeFileSync(join(repo, "app.js"), "import { add, clamp } from './src/math.js';\nconsole.log(clamp(add(1, 2), 0, 10));\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "head");
  const head = git(repo, "rev-parse", "HEAD").toString("utf8").trim();
  return { repo, base, head };
}

function diffFile(repo: string, base: string, head: string, path: string): Buffer {
  return git(repo, "diff", ...DIFF_ARGS, base, head, "--", path);
}

function authorNarrative(repo: string, base: string, head: string, artifact: string): string {
  writeFileSync(join(artifact, "diffs", "02-tests.diff"), diffFile(repo, base, head, "test/math.test.js"));
  writeFileSync(join(artifact, "diffs", "03-implementation.diff"), diffFile(repo, base, head, "src/math.js"));
  writeFileSync(join(artifact, "diffs", "04-refactor.diff"), diffFile(repo, base, head, "app.js"));
  writeFileSync(join(artifact, "steps", "02-tests.md"), "# Boundary coverage\n\nThe test captures values above the upper bound.\n");
  writeFileSync(join(artifact, "steps", "03-implementation.md"), "# Clamp values\n\nKeep numbers inside an inclusive range.\n");
  writeFileSync(join(artifact, "steps", "05-manual.md"), "# Exercise the app\n\n1. Run the application.\n2. Confirm the printed value is `3`.\n");
  writeFileSync(join(artifact, "steps", "01-problem.md"), "Start with the [math helper](src/math.js), then compare a [missing helper](src/missing.js).\n");
  const manifestPath = join(artifact, "narrative.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NarrativeManifest;
  manifest.title = "Introduce bounded arithmetic";
  manifest.summary = "Specify clamping, implement it, and update the app.";
  assert.ok(manifest.steps[0]);
  manifest.steps[0].checks = {
    automated: [{ label: "Clamp regression", status: "not-run", basis: "expected", detail: "The test does not exist yet." }],
    manual: [],
  };
  manifest.steps.push(
    {
      id: "add-clamp-test",
      title: "Codify the upper bound",
      kind: "tests",
      body: "steps/02-tests.md",
      diff: "diffs/02-tests.diff",
      cases: [{ name: "Caps values above max", description: "A value above the range resolves to the maximum.", change: "New regression case.", files: ["test/math.test.js"] }],
      checks: { automated: [{ label: "Clamp regression", status: "failing", basis: "expected" }], manual: [] },
    },
    {
      id: "implement-clamp",
      title: "Clamp values to a range",
      kind: "implementation",
      body: "steps/03-implementation.md",
      diff: "diffs/03-implementation.diff",
      sections: [{ name: "Bounds", priority: "critical", description: "The bounds algorithm determines the result. See [app](app.js).", files: [{ label: "Clamp arithmetic", file: "src/math.js" }] }],
      checks: { automated: [{ label: "Clamp regression", status: "passing", basis: "expected" }], manual: [] },
    },
    {
      id: "migrate-app",
      title: "Use clamping in the application",
      kind: "refactor",
      diff: "diffs/04-refactor.diff",
      interfaces: [{
        name: "clamp(value, min, max)",
        description: "Callers provide explicit bounds.",
        before: "add(1, 2)",
        after: "clamp(add(1, 2), 0, 10)",
        callsites: [{ label: "Application output", file: "app.js" }],
      }],
      checks: { automated: [{ label: "Clamp regression", status: "passing", basis: "expected" }], manual: [{ label: "Application output", status: "not-run", basis: "expected" }] },
    },
    {
      id: "verify-app",
      title: "Verify the application output",
      kind: "manual",
      body: "steps/05-manual.md",
      checks: { automated: [{ label: "Clamp regression", status: "passing", basis: "expected" }], manual: [{ label: "Application output", status: "passing", basis: "expected" }] },
    },
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

test("capture, validate, ingest, and load an exact narrative stack", () => {
  const { repo, base, head } = makeRepository();
  const artifact = mkdtempSync(join(tmpdir(), "heptapod-artifact-"));
  const captured = captureNarrative(repositoryRoot(repo), base, head, artifact, {
    githubPrUrl: "https://github.com/example/math/pull/42",
  });
  assert.equal(captured.files, 3);
  const manifestPath = authorNarrative(repo, base, head, artifact);
  const { manifest } = loadManifest(manifestPath);
  const verification = verifyNarrative(repo, manifest, manifestPath);
  assert.equal(verification.exact, true);
  assert.equal(verification.tree, git(repo, "rev-parse", `${head}^{tree}`).toString("utf8").trim());

  const databasePath = join(artifact, "reviews.sqlite");
  const ingested = ingestNarrative({
    id: "42",
    repo,
    narrativePath: manifestPath,
    databasePath,
    siteUrl: "http://127.0.0.1:4321",
  });
  assert.equal(ingested.url, "http://127.0.0.1:4321/reviews/42");
  assert.equal(ingested.payload.steps.length, 5);
  assert.deepEqual(ingested.payload.steps[0].referenceFiles?.map((file) => file.path), ["src/math.js"]);
  assert.match(ingested.payload.steps[0].body, /heptapod-file:src%2Fmath\.js/);
  assert.match(ingested.payload.steps[0].body, /\[missing helper\]\(src\/missing\.js\)/);
  const testArea = ingested.payload.steps.find((step) => step.kind === "tests")?.testAreas?.[0];
  assert.ok(testArea);
  assert.deepEqual(
    Object.fromEntries(testArea.files[0].cases.map((testCase) => [testCase.name, testCase.change])),
    {
      "keeps arithmetic stable": "changed",
      "caps values above max": "added",
      "covers legacy behavior": "removed",
    },
  );
  const implementationFile = ingested.payload.steps
    .find((step) => step.id === "implement-clamp")
    ?.fileDiffs.find((file) => file.path === "src/math.js");
  assert.match(implementationFile?.beforeContent ?? "", /export const add/);
  assert.match(implementationFile?.afterContent ?? "", /export const clamp/);
  const implementation = ingested.payload.steps.find((step) => step.id === "implement-clamp");
  assert.match(implementation?.sections?.[0].description ?? "", /heptapod-file:app\.js/);
  assert.deepEqual(implementation?.referenceFiles?.map((file) => file.path), ["app.js"]);
  assert.equal(ingested.payload.steps.find((step) => step.id === "migrate-app")?.interfaces?.[0].callsites[0].change, "changed");
  assert.equal(getReview("42", databasePath)?.payload.verification.exact, true);
  assert.deepEqual(listReviews(databasePath).map((review) => review.id), ["42"]);
  assert.equal(ingested.payload.testExecution?.command, null);
  assert.ok(ingested.payload.steps.every((step) => step.testRun?.status === "not-run"));

});

test("persists pending ingestion progress, failures, and cleanup", () => {
  const { repo, base, head } = makeRepository();
  const databasePath = join(repo, "reviews.sqlite");
  beginReviewIngestion("42", {
    title: "Pending review",
    summary: "Running tests",
    baseRevision: base,
    headRevision: head,
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
    process.env.HEPTAPOD_ROOT = repo;
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
    {
      url: attachment,
      label: "Conversation result",
      kind: "image",
      sourceUrl: "https://github.com/example/repo/pull/42",
    },
    {
      url: videoAttachment,
      label: "walkthrough.mov",
      kind: "video",
      sourceUrl: "https://github.com/example/repo/pull/42",
    },
  ]);
});

test("defaults review storage to the repository-local npm cache", () => {
  const { repo } = makeRepository();
  const previousRoot = process.env.HEPTAPOD_ROOT;
  try {
    process.env.HEPTAPOD_ROOT = repo;
    assert.equal(
      resolveDatabasePath(),
      join(repo, "node_modules", ".cache", "heptapod", "reviews.sqlite"),
    );
    assert.equal(
      resolveReviewRunDirectory("42"),
      join(repo, "node_modules", ".cache", "heptapod", "runs", "42"),
    );
    assert.equal(
      resolveReviewNarrativePath("42"),
      join(repo, "node_modules", ".cache", "heptapod", "runs", "42", "narrative.json"),
    );
  } finally {
    if (previousRoot === undefined) delete process.env.HEPTAPOD_ROOT;
    else process.env.HEPTAPOD_ROOT = previousRoot;
  }
});

test("validation rejects an incomplete stack", () => {
  const { repo, base, head } = makeRepository();
  const artifact = mkdtempSync(join(tmpdir(), "heptapod-artifact-"));
  captureNarrative(repo, base, head, artifact);
  const manifestPath = authorNarrative(repo, base, head, artifact);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NarrativeManifest;
  manifest.steps = manifest.steps.filter((step) => step.id !== "migrate-app");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const loaded = loadManifest(manifestPath);
  assert.throws(() => verifyNarrative(repo, loaded.manifest, manifestPath), /stacked steps produce tree/);
});

test("validation accepts meaningful intermediate content absent from the final diff", () => {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-intermediate-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "state.txt"), "state=initial\n");
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    name: "heptapod-test-project",
    version: "1.0.0",
    scripts: {
      postinstall: "node -e \"require('node:fs').writeFileSync('.dependencies-ready', 'yes')\"",
      test: "node test.mjs",
    },
  }, null, 2)}\n`);
  writeFileSync(join(repo, "package-lock.json"), `${JSON.stringify({
    name: "heptapod-test-project",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "heptapod-test-project", version: "1.0.0", hasInstallScript: true } },
  }, null, 2)}\n`);
  writeFileSync(join(repo, ".heptapod.json"), `${JSON.stringify({
    test: {
      prerequisites: [{ command: ["npm", "ci"] }],
      runner: { command: ["npm", "test", "--", "{files}"] },
    },
  }, null, 2)}\n`);
  writeFileSync(join(repo, "test.mjs"), "import { existsSync, readFileSync } from 'node:fs';\nif (!existsSync('.dependencies-ready')) { console.error('ERROR dependencies were not prepared'); process.exit(1); }\nif (readFileSync('state.txt', 'utf8') !== 'state=green\\n') { console.error('FAIL state is green'); process.exit(1); }\n");
  writeFileSync(join(repo, "second.test.mjs"), "console.log('second fixture passes');\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD").toString("utf8").trim();
  writeFileSync(join(repo, "state.txt"), "state=red\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "use a deliberately failing state");
  const middle = git(repo, "rev-parse", "HEAD").toString("utf8").trim();
  writeFileSync(join(repo, "state.txt"), "state=green\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "head");
  const head = git(repo, "rev-parse", "HEAD").toString("utf8").trim();

  const artifact = mkdtempSync(join(tmpdir(), "heptapod-intermediate-artifact-"));
  captureNarrative(repo, base, head, artifact);
  writeFileSync(join(artifact, "diffs", "02-red.diff"), git(repo, "diff", ...DIFF_ARGS, base, middle, "--"));
  writeFileSync(join(artifact, "diffs", "03-green.diff"), git(repo, "diff", ...DIFF_ARGS, middle, head, "--"));
  const manifestPath = join(artifact, "narrative.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NarrativeManifest;
  manifest.steps.push(
    {
      id: "red",
      title: "Expose the broken state",
      kind: "implementation",
      diff: "diffs/02-red.diff",
      sections: [{ name: "State", priority: "critical", description: "Defines the current behavior.", files: [{ label: "Behavior", file: "state.txt" }] }],
      checks: { automated: [{ label: "state is green", status: "failing", basis: "expected" }], manual: [] },
    },
    {
      id: "green",
      title: "Reach the working state",
      kind: "implementation",
      diff: "diffs/03-green.diff",
      sections: [{ name: "State", priority: "critical", description: "Defines the current behavior.", files: [{ label: "Behavior", file: "state.txt" }] }],
      checks: { automated: [{ label: "State check", status: "passing", basis: "expected" }], manual: [] },
    },
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const loaded = loadManifest(manifestPath);
  assert.equal(verifyNarrative(repo, loaded.manifest, manifestPath).exact, true);
  const worktreesBefore = git(repo, "worktree", "list", "--porcelain").toString("utf8");
  const changedTests = new Map<string, TestAreaChange[]>([
    ["red", [{
      name: "State behavior",
      description: "The state transition remains covered.",
      files: [{ path: "test.mjs", cases: [] }],
    }]],
    ["green", [{
      name: "Additional behavior",
      description: "A later test step adds another fixture to the cumulative set.",
      files: [{ path: "second.test.mjs", cases: [] }],
    }]],
  ]);
  const execution = executeNarrativeTests(repo, loaded.manifest, manifestPath, () => {}, changedTests);
  assert.equal(git(repo, "worktree", "list", "--porcelain").toString("utf8"), worktreesBefore);
  assert.equal(execution.metadata.command, "npm test");
  assert.equal(execution.metadata.dependencySource, "npm ci");
  assert.deepEqual(
    loaded.manifest.steps.map((step) => execution.runsByStep.get(step.id)?.status),
    ["not-run", "failing", "passing"],
  );
  assert.deepEqual(execution.runsByStep.get("problem-and-approach")?.unexpectedFailures, []);
  assert.deepEqual(execution.runsByStep.get("red")?.unexpectedFailures, []);
  assert.equal(execution.runsByStep.get("red")?.scope, "changed-tests");
  assert.deepEqual(execution.runsByStep.get("red")?.files, ["test.mjs"]);
  assert.deepEqual(
    execution.runsByStep.get("red")?.fixtureRuns.map(({ file, status }) => ({ file, status })),
    [{ file: "test.mjs", status: "failing" }],
  );
  assert.equal(execution.runsByStep.get("green")?.scope, "full-suite");
  assert.deepEqual(execution.runsByStep.get("green")?.files, ["test.mjs", "second.test.mjs"]);
  assert.deepEqual(
    execution.runsByStep.get("green")?.fixtureRuns.map(({ file, status }) => ({ file, status })),
    [
      { file: "test.mjs", status: "passing" },
      { file: "second.test.mjs", status: "passing" },
    ],
  );
  assert.equal(execution.runsByStep.get("green")?.expectationMatched, true);
});

test("binary patches and quoted Git paths retain their file identity", () => {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-binary-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "seed.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD").toString("utf8").trim();
  const binaryPath = "asset weird\tname.bin";
  writeFileSync(join(repo, binaryPath), Buffer.from([0, 1, 2, 3, 255, 0, 17]));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "binary asset");
  const head = git(repo, "rev-parse", "HEAD").toString("utf8").trim();

  const artifact = mkdtempSync(join(tmpdir(), "heptapod-binary-artifact-"));
  captureNarrative(repo, base, head, artifact);
  const patch = readFileSync(join(artifact, "source.diff"));
  assert.equal(splitPatchFiles(patch.toString("utf8"))[0].path, binaryPath);
  writeFileSync(join(artifact, "diffs", "02-binary.diff"), patch);
  const manifestPath = join(artifact, "narrative.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NarrativeManifest;
  manifest.steps.push({
    id: "binary-asset",
    title: "Add the binary asset",
    kind: "implementation",
    diff: "diffs/02-binary.diff",
    sections: [{ name: "Asset", priority: "critical", description: "The asset is the complete change.", files: [{ label: "Binary asset", file: binaryPath }] }],
    checks: { automated: [], manual: [] },
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const loaded = loadManifest(manifestPath);
  assert.equal(verifyNarrative(repo, loaded.manifest, manifestPath).exact, true);
});
