import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { checkDifftastic } from "../src/tool/difftastic.js";
import { generateSemanticDiffs } from "../src/tool/semantic-diff.js";
import type { RenderModel } from "../src/tool/types.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const repo of directories.splice(0)) rmSync(repo, { recursive: true, force: true }); });
function repository() {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-host-difft-"));
  directories.push(repo);
  vi.stubEnv("PATH", repo);
  return repo;
}
function install(repo: string) {
  const executable = join(repo, "difft");
  writeFileSync(executable, `#!${process.execPath}
if (process.env.DFT_CHECK_ONLY) process.exit(2);
if (process.argv.includes('--version')) console.log('Difftastic 0.70.0');
else console.log(JSON.stringify({ language:'TypeScript', status:'changed', aligned_lines:[[0,0],[1,1]], chunks:[[{lhs:{line_number:0,changes:[{start:10,end:11,content:'1'}]},rhs:{line_number:0,changes:[{start:10,end:11,content:'2'}]}}]] }));
`);
  chmodSync(executable, 0o755);
  return executable;
}
function model(): RenderModel {
  return { steps: [{ fileDiffs: [{ path: "x.ts", patch: "@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n", beforeContent: "const x = 1;\n", afterContent: "const x = 2;\n" }] }] } as RenderModel;
}

test("missing host executable uses standard diffs; installation enables structural ingestion", async () => {
  const repo = repository();
  assert.deepEqual(await checkDifftastic(repo), { installed: false });
  const missing = model();
  generateSemanticDiffs(repo, missing);
  assert.equal(missing.steps[0].fileDiffs[0].semanticDiff?.status, "fallback");
  const executable = install(repo);
  vi.stubEnv("DFT_CHECK_ONLY", "yes");
  assert.deepEqual(await checkDifftastic(repo), { installed: true, version: "Difftastic 0.70.0" });
  const installed = model();
  generateSemanticDiffs(repo, installed);
  assert.equal(installed.steps[0].fileDiffs[0].semanticDiff?.status, "ready");
  rmSync(executable);
  const removed = model();
  generateSemanticDiffs(repo, removed);
  assert.equal(removed.steps[0].fileDiffs[0].semanticDiff?.status, "fallback", "a cached diff does not bypass the host installation check");
  assert.equal(removed.diffGeneration?.version, null);
});

test("checklist and ingestion respect the same repository-relative host executable", async () => {
  const repo = repository();
  renameSync(install(repo), join(repo, "custom-difft"));
  writeFileSync(join(repo, ".heptapod.json"), JSON.stringify({ diff: { executable: "./custom-difft" } }));
  assert.equal((await checkDifftastic(repo)).installed, true);
  const data = model();
  generateSemanticDiffs(repo, data);
  assert.equal(data.steps[0].fileDiffs[0].semanticDiff?.status, "ready");
});

test("a program named difft must return a Difftastic version", async () => {
  const repo = repository();
  const executable = install(repo);
  writeFileSync(executable, `#!${process.execPath}\nconsole.log('Some other tool 1.0.0');\n`);
  assert.deepEqual(await checkDifftastic(repo), { installed: false });
});
