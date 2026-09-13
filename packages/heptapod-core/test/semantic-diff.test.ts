import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { generateSemanticDiffs, parseDifftasticOutput } from "../src/tool/semantic-diff.js";
import { loadHeptapodConfig } from "../src/tool/config.js";
import type { PatchFile, RenderModel } from "../src/tool/types.js";

const directories: string[] = [];
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "heptapod-semantic-test-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function file(path = "value.ts", beforeContent = "const value = 1;\n", afterContent = "const value = 2;\n"): PatchFile {
  return { path, beforeContent, afterContent, patch: `@@ -1 +1 @@\n-${beforeContent}+${afterContent}` };
}
function model(files: PatchFile[]): RenderModel {
  return { steps: [{ fileDiffs: files }] } as RenderModel;
}

function fakeDifft(repo: string) {
  const executable = join(repo, "difft");
  const log = join(repo, "calls.jsonl");
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('Difftastic 0.70.0'); process.exit(0); }
const oldPath = process.argv.at(-2), newPath = process.argv.at(-1);
const before = fs.readFileSync(oldPath, 'utf8'), after = fs.readFileSync(newPath, 'utf8');
const name = path.basename(newPath);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({name,before,after,oldPath,newPath}) + '\\n');
if (process.env.DFT_IGNORE_COMMENTS) process.exit(3);
if (name === 'failure.ts') process.exit(2);
if (name === 'timeout.ts') { setInterval(() => {}, 1000); }
else if (name === 'invalid.ts') console.log('{invalid');
else console.log(JSON.stringify({ language: 'TypeScript', status: 'changed', aligned_lines: [[0,0],[1,1]], chunks: [[{
  lhs: {line_number:0,changes:[{start:14,end:15,content:before[14]}]},
  rhs: {line_number:0,changes:[{start:14,end:15,content:after[14]}]}
}]] }));
`);
  chmodSync(executable, 0o755);
  return { executable, log };
}

test("ingestion caches exact step snapshots, retries failures, and isolates per-file errors", () => {
  const repo = temporary();
  const { executable, log } = fakeDifft(repo);
  vi.stubEnv("DFT_IGNORE_COMMENTS", "yes");
  const first = file(), later = file("value.ts", "const value = 2;\n", "const value = 3;\n");
  const data = model([first, file("failure.ts"), file("invalid.ts"), file("timeout.ts"), later, file()]);
  const progress: string[] = [];
  generateSemanticDiffs(repo, data, (message) => progress.push(message), { executable, timeoutMs: 1500 });
  assert.equal(first.semanticDiff?.status, "ready", JSON.stringify({ result: first.semanticDiff, metadata: data.diffGeneration }));
  assert.equal(later.semanticDiff?.status, "ready");
  assert.deepEqual(data.steps[0].fileDiffs[1].semanticDiff, { status: "fallback", reason: "Difftastic failed" });
  assert.equal(data.steps[0].fileDiffs[2].semanticDiff?.status, "fallback");
  assert.deepEqual(data.steps[0].fileDiffs[3].semanticDiff, { status: "fallback", reason: "Difftastic timed out" });
  assert.equal(data.diffGeneration?.ready, 3);
  assert.equal(data.diffGeneration?.fallback, 3);
  assert.match(progress.at(-1)!, /ready: 3; standard fallbacks: 3/);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls().length, 5);
  assert.deepEqual(calls().filter((call) => call.name === "value.ts").map((call) => [call.before, call.after]),
    [[first.beforeContent, first.afterContent], [later.beforeContent, later.afterContent]]);
  for (const call of calls()) assert.throws(() => readFileSync(call.oldPath));
  generateSemanticDiffs(repo, model([file(), file("failure.ts")]), () => {}, { executable, timeoutMs: 1500 });
  assert.equal(calls().length, 6, "successful results survive another ingestion; failed ones are retried");
});

test("missing executable, missing snapshots, binaries, and oversized inputs retain standard diffs", () => {
  const repo = temporary();
  const files = [file(), { ...file(), beforeContent: undefined }, file("nul.ts", "\0", "x"), file("huge.ts", "x".repeat(1_000_001), "x")];
  const data = model(files);
  const patches = files.map((file) => file.patch);
  generateSemanticDiffs(repo, data, () => {}, { executable: join(repo, "missing") });
  assert.ok(files.every((file) => file.semanticDiff?.status === "fallback"));
  assert.deepEqual(files.map((file) => file.patch), patches);
  assert.equal(data.diffGeneration?.version, null);
  const disabled = model([file()]);
  generateSemanticDiffs(repo, disabled, () => {}, { engine: "standard" });
  assert.equal(disabled.steps[0].fileDiffs[0].semanticDiff, undefined);
});

test("JSON validation converts Unicode byte offsets and rejects mismatched locations", () => {
  const before = '😀 é = 1;\n', after = '😀 é = 2;\n';
  const output = { language: "TypeScript", status: "changed", aligned_lines: [[0,0],[1,1]], chunks: [[{
    lhs: { line_number: 0, changes: [{ start: 10, end: 11, content: "1" }] },
    rhs: { line_number: 0, changes: [{ start: 10, end: 11, content: "2" }] },
  }]] };
  const parsed = parseDifftasticOutput(JSON.stringify([output]), before, after);
  assert.equal(parsed.status, "ready");
  if (parsed.status !== "ready") return;
  assert.deepEqual(parsed.alignment, [[1,1]]);
  assert.equal(before.slice(parsed.before[1][0].start, parsed.before[1][0].end), "1");
  assert.equal(after.slice(parsed.after[1][0].start, parsed.after[1][0].end), "2");
  assert.equal(parseDifftasticOutput(JSON.stringify({ ...output, aligned_lines: [[5,5]] }), before, after).status, "fallback");
  assert.equal(parseDifftasticOutput(JSON.stringify(output), "different", after).status, "fallback");
  assert.equal(parseDifftasticOutput(JSON.stringify({ ...output, language: "Text (exceeded DFT_GRAPH_LIMIT)" }), before, after).status, "fallback");
});

test("diff configuration is optional and validates engine, executable, and timeout", () => {
  const repo = temporary();
  for (const diff of [null, [], { engine: "other" }, { executable: "" }, { timeoutMs: -1 }, { timeoutMs: 0.1 }]) {
    writeFileSync(join(repo, ".heptapod.json"), JSON.stringify({ diff }));
    assert.throws(() => loadHeptapodConfig(repo), /Invalid .heptapod.json: diff/);
  }
  writeFileSync(join(repo, ".heptapod.json"), JSON.stringify({ diff: { engine: "standard", timeoutMs: 500 } }));
  assert.deepEqual(loadHeptapodConfig(repo)?.diff, { engine: "standard", timeoutMs: 500 });
});

test.skipIf(!process.env.HEPTAPOD_TEST_DIFFT)("real Difftastic handles wrapping, formatting, Unicode, lifecycle changes, and text fallback", () => {
  const repo = temporary();
  const files: PatchFile[] = [
    file("wrap.ts", "const total = price + tax;\n", "const total = round(price + tax);\n"),
    file("format.ts", "const x = 1;\n", "const x =\n  1;\n"),
    file("unicode.ts", '\tconst x = "😀"; const y = 1;\r\n', '\tconst x = "😀"; const y = 2;\r\n'),
    { ...file("new.ts"), beforeContent: null },
    { ...file("deleted.ts"), afterContent: null },
    file("plain.txt", "hello\n", "world\n"),
    file("invalid.ts", "const x = (\n", "const x = )\n"),
  ];
  generateSemanticDiffs(repo, model(files), () => {}, { executable: process.env.HEPTAPOD_TEST_DIFFT });
  assert.deepEqual(files.map((file) => file.semanticDiff?.status), ["ready", "ready", "ready", "ready", "ready", "fallback", "fallback"]);
  const wrap = files[0].semanticDiff;
  if (wrap?.status !== "ready") return;
  assert.deepEqual(wrap.before[1], []);
  assert.deepEqual(wrap.after[1].map((range) => files[0].afterContent!.slice(range.start, range.end)), ["round(", ")"]);
  const formatting = files[1].semanticDiff;
  assert.ok(formatting?.status === "ready" && formatting.unchanged);
  const unicode = files[2].semanticDiff;
  if (unicode?.status === "ready") assert.equal(files[2].afterContent!.slice(unicode.after[1][0].start, unicode.after[1][0].end), "2");
});
