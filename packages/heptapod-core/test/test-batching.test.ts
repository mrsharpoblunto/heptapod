import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { loadHeptapodConfig } from "../src/tool/config.js";
import { commandRunner } from "../src/tool/test-runners/command.js";
import { googletestRunner } from "../src/tool/test-runners/googletest.js";
import { vitestRunner } from "../src/tool/test-runners/vitest.js";
const directories: string[] = [];
function temporary() { const dir = mkdtempSync(join(tmpdir(), "heptapod-batches-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("runner rebuild decisions distinguish source changes from dependency metadata", () => {
  for (const paths of [["src/file.ts"], ["test/file.test.ts"], []]) assert.equal(vitestRunner.requiresRebuild(paths), false);
  for (const file of ["package.json", "packages/inner/package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "pnpm-workspace.yaml"])
    assert.equal(vitestRunner.requiresRebuild([file]), true, file);
  assert.equal(googletestRunner.requiresRebuild(["include/shared.h"]), true);
  assert.equal(commandRunner.requiresRebuild(["src/input.txt"]), true);
  assert.equal(googletestRunner.requiresRebuild([]), false);
});

test("Vitest batches only fixtures in the same owning package and uses unique result files", () => {
  const root = temporary();
  for (const dir of [root, join(root, "packages/one"), join(root, "packages/two")]) {
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  }
  const batches = vitestRunner.batch!(root, ["npm", "test", "--", "{files}"], ["packages/one/a.test.ts", "packages/one/with space.test.ts", "packages/two/a.test.ts"], "auto", root);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].files, ["packages/one/a.test.ts", "packages/one/with space.test.ts"]);
  assert.deepEqual(batches[0].command?.args.slice(0, 4), ["test", "--", "a.test.ts", "with space.test.ts"]);
  assert.equal(batches[0].command?.cwd, join(root, "packages/one"));
  assert.notEqual(batches[0].command?.resultFile, batches[1].command?.resultFile);
});

test("Vitest JSON reports preserve passing, failing, and skipped fixture results", () => {
  const root = temporary();
  const files = ["a.test.ts", "b.test.ts", "skip.test.ts"];
  const command = vitestRunner.fullCommand(["vitest", "run"], root);
  writeFileSync(command.resultFile!, JSON.stringify({ testResults: [
    { name: resolve(root, "a.test.ts"), status: "passed", startTime: 1, endTime: 3,
      assertionResults: [{ status: "passed", fullName: "passes" }] },
    { name: resolve(root, "b.test.ts"), status: "failed", startTime: 3, endTime: 7,
      assertionResults: [{ status: "failed", fullName: "fails" }] },
    { name: resolve(root, "skip.test.ts"), status: "passed", startTime: 7, endTime: 7,
      assertionResults: [{ status: "skipped", fullName: "skips" }] },
  ] }));
  const results = vitestRunner.parseBatchResult!("", command, files, root, "auto");
  assert.equal(results["a.test.ts"].status, "passing");
  assert.equal(results["b.test.ts"].status, "failing");
  assert.deepEqual(results["b.test.ts"].failures, ["b.test.ts > fails"]);
  assert.equal(results["skip.test.ts"].status, "not-run");
  assert.equal(results["a.test.ts"].durationMs, 2);
});

test("GoogleTest batches selectors and attributes parameterized failures to their fixture", () => {
  const root = temporary();
  writeFileSync(join(root, "a.cpp"), "TEST(First, Works) {}\n");
  writeFileSync(join(root, "b.cpp"), "TEST_P(Second, Fails) {}\n");
  writeFileSync(join(root, "empty.cpp"), "// no selectors\n");
  const batches = googletestRunner.batch!(root, ["./tests"], ["a.cpp", "b.cpp", "empty.cpp"], "auto", root);
  const batch = batches.find(batch => batch.command)!;
  assert.deepEqual(batch.files, ["a.cpp", "b.cpp"]);
  assert.ok(batch.command?.args.includes("--gtest_filter=First.Works:*/Second.Fails/*"));
  assert.equal(batches.find(batch => !batch.command)?.files[0], "empty.cpp");
  const results = googletestRunner.parseBatchResult!("[       OK ] First.Works (2 ms)\n[  FAILED  ] Values/Second.Fails/0 (3 ms)\n[  FAILED  ] Values/Second.Fails/0\n", batch.command!, batch.files, root, "auto");
  assert.equal(results["a.cpp"].status, "passing");
  assert.equal(results["b.cpp"].status, "failing");
  assert.equal(results["b.cpp"].durationMs, 3);
  assert.deepEqual(results["b.cpp"].failures, ["Values/Second.Fails/0"]);
});

test("configuration validates batch and rebuild policies", () => {
  const repo = temporary();
  for (const runner of [{ format: "vitest", batch: "yes" }, { format: "vitest", rebuild: true }, { format: "vitest", rebuild: "sometimes" }, { format: "command", batch: true }]) {
    writeFileSync(join(repo, ".heptapod.json"), JSON.stringify({ test: { runner: { command: ["test"], ...runner } } }));
    assert.throws(() => loadHeptapodConfig(repo), /Invalid .heptapod.json/);
  }
});
