import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const processMocks = vi.hoisted(() => ({ run: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../src/tool/process.js", () => ({ run: processMocks.run }));
vi.mock("node:child_process", async (load) => ({
  ...(await load<typeof import("node:child_process")>()),
  spawnSync: processMocks.spawnSync,
}));

import { executeNarrativeTests } from "../src/tool/test-execution.js";
import type { NarrativeManifest, TestAreaChange } from "../src/tool/types.js";

const directories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("test execution orchestrates mocked worktrees and commands", () => {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-execution-unit-"));
  directories.push(repo);
  writeFileSync(join(repo, ".heptapod.json"), JSON.stringify({
    test: { runner: { format: "command", command: ["runner", "{files}"] } },
  }));
  const patch = "diff --git a/test.mjs b/test.mjs\n--- a/test.mjs\n+++ b/test.mjs\n@@ -1 +1 @@\n-old\n+new\n";
  writeFileSync(join(repo, "tests.diff"), patch);
  const manifest: NarrativeManifest = {
    schemaVersion: 1, title: "Execution", summary: "Mock process boundaries",
    source: { base: "a".repeat(40), head: "b".repeat(40), diff: "source.diff" },
    steps: [
      {
        id: "tests", title: "Expose behavior", kind: "tests", diff: "tests.diff",
        cases: [{ name: "Behavior", description: "Exercises the behavior", files: ["test.mjs"] }],
        checks: { automated: [{ label: "Behavior", basis: "expected", status: "failing" }], manual: [] },
      },
      {
        id: "fix", title: "Fix behavior", kind: "manual",
        checks: { automated: [{ label: "Behavior", basis: "expected", status: "passing" }], manual: [] },
      },
    ],
  };
  const areas = new Map<string, TestAreaChange[]>([["tests", [{
    name: "Behavior", description: "", files: [{ path: "test.mjs", cases: [] }],
  }]]]);
  processMocks.run.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === "worktree" && args[1] === "add") {
      const worktree = args[3];
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, "test.mjs"), "test fixture\n");
    }
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  processMocks.spawnSync
    .mockReturnValueOnce({ status: 1, stdout: "expected failure", stderr: "" })
    .mockReturnValueOnce({ status: 0, stdout: "pass", stderr: "" });

  const execution = executeNarrativeTests(repo, manifest, join(repo, "narrative.json"), () => {}, areas);
  assert.equal(execution.metadata.command, "runner");
  assert.deepEqual(execution.runsByStep.get("tests")?.files, ["test.mjs"]);
  assert.equal(execution.runsByStep.get("tests")?.status, "failing");
  assert.equal(execution.runsByStep.get("tests")?.expectationMatched, true);
  assert.equal(execution.runsByStep.get("fix")?.status, "passing");
  assert.equal(execution.runsByStep.get("fix")?.scope, "full-suite");
  assert.deepEqual(processMocks.spawnSync.mock.calls.map((call) => call[1]), [["test.mjs"], []]);
  assert.ok(processMocks.run.mock.calls.some((call) => call[1][0] === "worktree" && call[1][1] === "add"));
  assert.ok(processMocks.run.mock.calls.some((call) => call[1][0] === "worktree" && call[1][1] === "remove"));
});
