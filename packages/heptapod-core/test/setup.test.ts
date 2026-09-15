import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { loadPullRequestPage, checkGitHub, checkSkills } from "../src/tool/setup.js";
import { loadHeptapodConfig } from "../src/tool/config.js";
import { detectAgents } from "../src/tool/agents.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "heptapod-setup-")); directories.push(root);
  const executable = (name: string, script: string) => writeFileSync(join(root, name), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  vi.stubEnv("PATH", root);
  return { root, executable };
}
test("fetches bounded pages of open PRs with cursors and metadata", async () => {
  const { root, executable } = fixture();
  executable("gh", `const fs=require('node:fs'); const path=require('node:path'); const args=process.argv; fs.writeFileSync(path.join(path.dirname(process.argv[1]),'args'),args.join('\\n'));
    const next=args.includes('endCursor=next-page');
    if(args.includes('--paginate')||args.includes('--slurp')) process.exit(1);
    const pr=(number,draft=false)=>({number,state:'OPEN',isDraft:draft,title:'PR '+number,url:'https://github.com/example/repo/pull/'+number,createdAt:'2026-09-'+number+'T00:00:00Z',baseRefOid:'1111111111111111111111111111111111111111',headRefOid:'2222222222222222222222222222222222222222',additions:25,deletions:7,author:{login:'user',avatarUrl:'https://example.com/avatar',url:'https://github.com/user'}});
    console.log(JSON.stringify({data:{repository:{pullRequests:{nodes:next?[pr(10)]:[pr(12,true),pr(11)],pageInfo:{hasNextPage:!next,endCursor:next?'last-page':'next-page'}}}}}));`);
  const first = await loadPullRequestPage("example/repo", undefined, 10);
  assert.deepEqual(first.pullRequests.map((pr) => pr.metadata.state), ["draft", "open"]);
  assert.equal(first.hasNextPage, true); assert.equal(first.endCursor, "next-page");
  assert.equal(first.pullRequests[0].baseRevision, "1".repeat(40));
  assert.equal(first.pullRequests[0].headRevision, "2".repeat(40));
  assert.equal(first.pullRequests[0].additions, 25); assert.equal(first.pullRequests[0].deletions, 7);
  assert.match(readFileSync(join(root, "args"), "utf8"), /pullRequests\(first:10,after:\$endCursor,states:\[OPEN\]/);
  assert.doesNotMatch(readFileSync(join(root, "args"), "utf8"), /CLOSED|MERGED/);
  await assert.rejects(loadPullRequestPage("example/repo", undefined, 101), /between 1 and 100/);
  const second = await loadPullRequestPage("example/repo", first.endCursor!);
  assert.deepEqual(second.pullRequests.map((pr) => pr.number), [10]);
  assert.equal(second.pullRequests[0].metadata.state, "open"); assert.equal(second.hasNextPage, false);
});
test("distinguishes missing CLIs and skills without probing agent login state", async () => {
  const { root, executable } = fixture();
  assert.deepEqual(await checkGitHub(), { installed: false, authenticated: false });
  assert.equal(await checkSkills(root), false);
  executable("gh", `process.exit(process.argv[2]==='--version'?0:1);`);
  executable("codex", `process.exit(process.argv[2]==='--version'?0:1);`);
  executable("claude", `console.log(JSON.stringify({loggedIn:true}));`);
  mkdirSync(join(root, ".claude/skills/heptapod"), { recursive: true }); writeFileSync(join(root, ".claude/skills/heptapod/SKILL.md"), "Skill");
  assert.deepEqual(await checkGitHub(), { installed: true, authenticated: false });
  const [codex, claude] = await detectAgents(root);
  assert.equal(codex.installed, true); assert.equal(codex.skillInstalled, false);
  assert.equal(claude.installed, true); assert.equal(claude.skillInstalled, true);
});

test("agent preferences order detected agents and append omitted agents", async () => {
  const { root, executable } = fixture();
  executable("codex", "process.exit(0);"); executable("claude", "console.log(JSON.stringify({loggedIn:true}));");
  writeFileSync(join(root, ".heptapod.json"), JSON.stringify({ agents: { preferenceOrder: ["claude"] } }));
  assert.deepEqual((await detectAgents(root)).map((agent) => agent.id), ["claude", "codex"]);
  for (const preferenceOrder of [["unknown"], ["codex", "codex"], "claude"]) {
    writeFileSync(join(root, ".heptapod.json"), JSON.stringify({ agents: { preferenceOrder } }));
    assert.throws(() => loadHeptapodConfig(root), /agents.preferenceOrder/);
  }
});
