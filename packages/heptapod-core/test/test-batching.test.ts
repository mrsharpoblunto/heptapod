import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { loadHeptapodConfig } from "../src/tool/config.js";
import { executeNarrativeTests } from "../src/tool/test-execution.js";
import { commandRunner } from "../src/tool/test-runners/command.js";
import { googletestRunner } from "../src/tool/test-runners/googletest.js";
import { vitestRunner } from "../src/tool/test-runners/vitest.js";
import type { NarrativeManifest, TestAreaChange } from "../src/tool/types.js";
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

test("real Vitest batch and full-suite reports preserve passing, failing, and skipped fixture results", () => {
  const root = temporary();
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "a.test.ts"), "import { test, expect } from 'vitest'; test('passes',()=>expect(1).toBe(1));");
  writeFileSync(join(root, "b.test.ts"), "import { test, expect } from 'vitest'; test('fails',()=>expect(1).toBe(2));");
  writeFileSync(join(root, "skip.test.ts"), "import { test } from 'vitest'; test.skip('skips',()=>{});");
  const files = ["a.test.ts", "b.test.ts", "skip.test.ts"];
  const batch = vitestRunner.batch!(root, [process.execPath, resolve("node_modules/vitest/vitest.mjs"), "run", "{files}"], files, "auto", root)[0];
  const command = batch.command!;
  const result = spawnSync(command.executable, command.args, { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 30_000 });
  assert.equal(result.status, 1, result.stderr);
  const results = vitestRunner.parseBatchResult!(result.stdout, command, files, root, "auto");
  assert.equal(results["a.test.ts"].status, "passing");
  assert.equal(results["b.test.ts"].status, "failing");
  assert.deepEqual(results["b.test.ts"].failures, ["b.test.ts > fails"]);
  assert.equal(results["skip.test.ts"].status, "not-run");
  const full = vitestRunner.fullCommand([process.execPath, resolve("node_modules/vitest/vitest.mjs"), "run", "{files}"], root);
  assert.ok(files.every(file => !full.args.includes(file)));
  const fullResult = spawnSync(full.executable, full.args, { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 30_000 });
  assert.equal(fullResult.status, 1, fullResult.stderr);
  const fullResults = vitestRunner.parseBatchResult!(fullResult.stdout, full, files, root, "auto");
  assert.equal(fullResults["a.test.ts"].status, "passing");
  assert.equal(fullResults["b.test.ts"].status, "failing");
  assert.deepEqual(fullResults["b.test.ts"].failures, ["b.test.ts > fails"]);
  assert.equal(fullResults["skip.test.ts"].status, "not-run");
}, 30_000);

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

function executionRepository(options: { rebuild?: "auto" | "always" | "never"; batch?: boolean; missingReport?: boolean } = {}) {
  const repo = temporary();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node runner.mjs" }, version: "1.0.0" }));
  writeFileSync(join(repo, "state.txt"), "base");
  writeFileSync(join(repo, "a.test.ts"), "it('a',()=>{});"); writeFileSync(join(repo, "b.test.ts"), "it('b',()=>{});");
  writeFileSync(join(repo, "runner.mjs"), `
import {appendFileSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
const args=process.argv.slice(2), files=args.filter(arg=>arg.endsWith('.test.ts'));
const selected=files.length?files:['a.test.ts','b.test.ts'];
const state=readFileSync('state.txt','utf8');
appendFileSync(process.env.HEPTAPOD_REPOSITORY+'/run-log',JSON.stringify({files,state,mtime:statSync('a.test.ts').mtimeMs})+'\\n');
const failed=state==='red'&&selected.includes('b.test.ts');
if(failed)console.log('⎯⎯ Failed Tests 1 ⎯⎯\\n FAIL b.test.ts > b');
console.log('Test Files '+(failed?'1 failed | 1 passed (2)':'2 passed (2)')+'\\nTests '+(failed?'1 failed | 1 passed (2)':'2 passed (2)'));
const report=args.find(arg=>arg.startsWith('--outputFile.json='));
if(report && ${!options.missingReport}) writeFileSync(report.slice('--outputFile.json='.length),JSON.stringify({testResults:selected.map(file=>({name:resolve(file),status:state==='red'&&file==='b.test.ts'?'failed':'passed',startTime:0,endTime:1,assertionResults:[{status:state==='red'&&file==='b.test.ts'?'failed':'passed',fullName:file[0]}]}))}));
process.exit(failed?1:0);
`);
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  const revisions = [base];
  for (const state of ["red", "green", "metadata"]) {
    if (state === "metadata") writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node runner.mjs" }, version: "2.0.0" }));
    else writeFileSync(join(repo, "state.txt"), state);
    git("add", "."); git("commit", "-qm", state); revisions.push(git("rev-parse", "HEAD"));
  }
  for (let index = 0; index < 3; index++) writeFileSync(join(repo, `${index}.diff`), git("diff", "--binary", revisions[index], revisions[index + 1]) + "\n");
  writeFileSync(join(repo, ".heptapod.json"), JSON.stringify({ test: {
    prerequisites: [{ command: [process.execPath, "-e", "require('node:fs').appendFileSync(process.env.HEPTAPOD_REPOSITORY+'/setup-log','setup\\n')"] }],
    build: [{ command: [process.execPath, "-e", "const fs=require('node:fs');fs.appendFileSync(process.env.HEPTAPOD_REPOSITORY+'/build-log',fs.readFileSync('state.txt','utf8')+'\\n')"] }],
    runner: { format: "vitest", command: [process.execPath, "runner.mjs", "{files}"], rebuild: options.rebuild, batch: options.batch },
  } }));
  const manifest: NarrativeManifest = { schemaVersion: 1, title: "Batch tests", summary: "", source: { base, head: revisions.at(-1)!, diff: "source.diff" },
    steps: ["red", "green", "metadata", "final"].map((id, index) => ({ id, title: id, kind: index === 3 ? "manual" : "implementation", ...(index < 3 ? { diff: `${index}.diff` } : {}),
      checks: { automated: [{ label: "b", status: index === 0 ? "failing" : "passing", basis: "expected" }], manual: [] } })) };
  const areas = new Map<string, TestAreaChange[]>([["red", [{ name: "Fixtures", description: "", files: ["a.test.ts", "b.test.ts"].map(path => ({ path, cases: [] })) }]]]);
  const execute = () => executeNarrativeTests(repo, manifest, join(repo, "narrative.json"), () => {}, areas);
  return { repo, execute };
}

test("execution batches fixtures, rebuilds Vitest only on metadata changes, and preserves source mtimes", () => {
  const { repo, execute } = executionRepository();
  const result = execute();
  assert.equal(readFileSync(join(repo, "build-log"), "utf8"), "red\ngreen\n");
  assert.equal(readFileSync(join(repo, "setup-log"), "utf8"), "setup\nsetup\n");
  const runs = readFileSync(join(repo, "run-log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(runs.length, 4, "one batch per intermediate step and only the full suite at the final step");
  assert.deepEqual(runs.at(-1).files, [], "the final suite has no fixture filters");
  assert.equal(new Set(runs.map(run => run.mtime)).size, 1, "unchanged sources are not rewritten between steps");
  assert.deepEqual(runs[0].files, ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(result.runsByStep.get("red")?.fixtureRuns.map(run => run.status), ["passing", "failing"]);
  assert.deepEqual(result.runsByStep.get("green")?.fixtureRuns.map(run => run.status), ["passing", "passing"]);
  assert.equal(result.runsByStep.get("final")?.status, "passing");
  assert.deepEqual(result.runsByStep.get("final")?.fixtureRuns.map(run => run.status), ["passing", "passing"]);
});

test("explicit rebuild and batching overrides are respected", () => {
  for (const rebuild of ["always", "never"] as const) {
    const { repo, execute } = executionRepository({ rebuild, batch: false }); execute();
    assert.equal(readFileSync(join(repo, "build-log"), "utf8"), rebuild === "always" ? "red\ngreen\ngreen\n" : "red\n");
    const runs = readFileSync(join(repo, "run-log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(runs.length, 7);
    assert.deepEqual(runs.at(-1).files, []);
    assert.deepEqual(runs[0].files, ["a.test.ts"]);
  }
});

test("missing batch reports cannot silently pass even when the full suite succeeds", () => {
  const { execute } = executionRepository({ missingReport: true });
  const result = execute().runsByStep.get("final")!;
  assert.equal(result.status, "failing");
  assert.match(result.detail ?? "", /individual batch results/);
  assert.ok(result.fixtureRuns.every(run => run.status === "failing"));
});

test("configuration validates batch and rebuild policies", () => {
  const repo = temporary();
  for (const runner of [{ format: "vitest", batch: "yes" }, { format: "vitest", rebuild: true }, { format: "vitest", rebuild: "sometimes" }, { format: "command", batch: true }]) {
    writeFileSync(join(repo, ".heptapod.json"), JSON.stringify({ test: { runner: { command: ["test"], ...runner } } }));
    assert.throws(() => loadHeptapodConfig(repo), /Invalid .heptapod.json/);
  }
});
