import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { getReview } from "@thestraylight/heptapod-core/database";
import { createApiServer } from "../dist/server.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(invalid = false) {
  const root = mkdtempSync(join(tmpdir(), "heptapod-api-")); directories.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  git("remote", "add", "origin", "https://github.com/example/repo.git");
  writeFileSync(join(root, "sample.txt"), "before\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "sample.txt"), "after\n"); git("add", "."); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
  const bin = join(root, "bin"); mkdirSync(bin);
  const executable = (name: string, script: string) => writeFileSync(join(bin, name), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  executable("gh", `const args = process.argv.slice(2);
    if (args[0] === '--version' || args[0] === 'auth') process.exit(0);
    if (args.includes('--paginate')) console.log(JSON.stringify([[{ number: 42, title: 'Update sample', html_url: 'https://github.com/example/repo/pull/42', created_at: '2026-09-12T00:00:00Z', user: { login: 'test', avatar_url: 'https://example.com/avatar', html_url: 'https://github.com/test' } }]]));
    else console.log(JSON.stringify({ baseRefOid: '${base}', headRefOid: '${head}', url: 'https://github.com/example/repo/pull/42' }));`);
  executable("claude", "process.exit(1);");
  executable("codex", `const args = process.argv.slice(2); if (args[0] !== 'exec') process.exit(0);
    const fs = require('node:fs'); const path = require('node:path');
    fs.appendFileSync(path.join(process.env.HEPTAPOD_ROOT, 'agent-used'), path.basename(process.argv[1])+'\\n');
    const dir = path.join(process.env.HEPTAPOD_ROOT, 'node_modules/.cache/heptapod/runs/42');
    if (fs.existsSync(path.join(process.env.HEPTAPOD_ROOT, 'hold-agent'))) {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
      process.on('SIGTERM', () => {});
      fs.writeFileSync(path.join(process.env.HEPTAPOD_ROOT, 'agent-pids.json'), JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    } else setTimeout(() => {
      if (${invalid}) process.exit(0);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'narrative.json'), 'utf8'));
      manifest.title = 'Update sample'; manifest.summary = 'Explain the sample update.';
      manifest.steps.push({ id: 'implementation', title: 'Update sample', kind: 'implementation', body: 'steps/change.md', diff: 'diffs/change.diff', sections: [{ name: 'Sample', priority: 'critical', description: 'Update the sample.', files: [{ label: 'Sample', file: 'sample.txt' }] }], checks: { automated: [], manual: [] } });
      fs.writeFileSync(path.join(dir, 'narrative.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(dir, 'steps/change.md'), 'The sample changes.');
      fs.copyFileSync(path.join(dir, 'source.diff'), path.join(dir, 'diffs/change.diff'));
    }, 700);`);
  for (const host of [".agents", ".claude"]) { mkdirSync(join(root, host, "skills/heptapod"), { recursive: true }); writeFileSync(join(root, host, "skills/heptapod/SKILL.md"), "Test skill"); }
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`); vi.stubEnv("HEPTAPOD_ROOT", root); vi.stubEnv("HEPTAPOD_DB", join(root, "reviews.sqlite"));
  return { root, base, head };
}
async function running(root: string) {
  const api = createApiServer({ root, webOrigin: "http://localhost:3000" });
  api.server.listen(0, "127.0.0.1"); await once(api.server, "listening");
  const address = api.server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, origin = "http://localhost:3000") => fetch(`${url}${path}`, { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const waitForJob = async (id: string) => {
    for (let i = 0; i < 150; i++) { const job = await (await fetch(`${url}/jobs/${encodeURIComponent(id)}`)).json(); if (job.status !== "pending") return job; await delay(100); }
    throw new Error("Job timed out");
  };
  return { ...api, url, post, waitForJob };
}

test("accepts preparation immediately, rejects duplicates, polls during agent work, and ingests verified metadata", async () => {
  const { root } = fixture(); const api = await running(root);
  try {
    const response = await api.post("/reviews/prepare", { number: 42, agent: "codex" });
    assert.equal(response.status, 202); const accepted = await response.json();
    assert.equal(getReview("42")?.status, "preparing");
    assert.equal(existsSync(getReview("42")!.metadataDirectory!), true);
    assert.equal((await api.post("/reviews/prepare", { number: 42, agent: "codex" })).status, 409);
    assert.equal((await (await fetch(`${api.url}/health`)).json()).ready, true);
    const progress = await (await fetch(`${api.url}/reviews?review=42`)).json();
    assert.equal(progress.status, "preparing");
    const preparing = await (await fetch(`${api.url}/reviews`)).json();
    assert.equal(preparing[0].id, "42");
    assert.equal(preparing[0].hasPayload, false);
    assert.equal(preparing[0].status, "preparing");
    assert.equal(typeof preparing[0].title, "string");
    const job = await api.waitForJob(accepted.jobId); assert.equal(job.status, "ready", job.error);
    assert.equal(getReview("42")?.status, "ready"); assert.equal(getReview("42")?.payload?.verification.exact, true);
    const summaries = await (await fetch(`${api.url}/reviews`)).json();
    assert.equal(summaries[0].title, "Update sample");
    assert.equal(summaries[0].sourceUrl, "https://github.com/example/repo/pull/42");
    assert.equal(summaries[0].headRevision, getReview("42")?.payload?.source.head);
    assert.equal(summaries[0].hasPayload, true);
    assert.equal(summaries[0].updating, false);
    assert.equal(summaries[0].additions, 1);
    assert.equal(summaries[0].deletions, 1);
    assert.equal("payload" in summaries[0], false);
  } finally { await api.stop(); }
}, 20_000);

test("an agent exiting successfully with incomplete metadata fails validation instead of ingesting", async () => {
  const { root } = fixture(true); const api = await running(root);
  try {
    const accepted = await (await api.post("/reviews/prepare", { number: 42, agent: "codex" })).json();
    assert.equal((await api.waitForJob(accepted.jobId)).status, "failed");
    assert.equal(getReview("42")?.status, "failed"); assert.equal(getReview("42")?.payload, null);
  } finally { await api.stop(); }
}, 20_000);

test("rejects cross-site launch and unsupported agents, and exposes capture through the shared API", async () => {
  const { root, base, head } = fixture(); const api = await running(root);
  try {
    assert.equal((await api.post("/reviews/prepare", { number: 42, agent: "codex" }, "https://other.example")).status, 403);
    assert.equal((await api.post("/reviews/prepare", { number: 42, agent: "shell" })).status, 400);
    const response = await api.post("/reviews/capture", { rev: `${base}...${head}` }); assert.equal(response.status, 202);
    const job = await api.waitForJob((await response.json()).jobId);
    assert.equal(job.status, "ready", job.error); assert.equal(job.result.id, `${base}/${head}`);
    assert.equal(getReview(job.result.id)?.status, "preparing");
  } finally { await api.stop(); }
}, 20_000);


async function waitUntil(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(50); }
  throw new Error("Condition did not become true");
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("deleting a preparing review kills the agent and its descendants before removing metadata, and permits reimport", async () => {
  const { root } = fixture();
  writeFileSync(join(root, "hold-agent"), "");
  const api = await running(root);
  try {
    const accepted = await (await api.post("/reviews/prepare", { number: 42, agent: "codex" })).json();
    await waitUntil(() => existsSync(join(root, "agent-pids.json")));
    const pids = JSON.parse(readFileSync(join(root, "agent-pids.json"), "utf8")) as number[];
    const directory = getReview("42")!.metadataDirectory!;
    const response = await fetch(`${api.url}/reviews?review=42`, { method: "DELETE", headers: { origin: "http://localhost:3000" } });
    assert.equal(response.status, 200);
    assert.equal((await api.waitForJob(accepted.jobId)).status, "cancelled");
    await waitUntil(() => pids.every((pid) => !alive(pid)));
    assert.equal(getReview("42"), null);
    assert.equal(existsSync(directory), false);
    await delay(800);
    assert.equal(getReview("42"), null);
    rmSync(join(root, "hold-agent"));
    const retry = await api.post("/reviews/prepare", { number: 42, agent: "codex" });
    assert.equal(retry.status, 202);
    assert.equal((await api.waitForJob((await retry.json()).jobId)).status, "ready");
  } finally { await api.stop(); }
}, 20_000);

test("deleting an ingesting review cancels a synchronous test subprocess without recreating the review", async () => {
  const { root } = fixture(); const api = await running(root);
  try {
    const accepted = await (await api.post("/reviews/prepare", { number: 42, agent: "codex" })).json();
    assert.equal((await api.waitForJob(accepted.jobId)).status, "ready");
    const script = join(root, "blocking-test.cjs");
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(join(root, "test-pid"))}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
    writeFileSync(join(root, ".heptapod.json"), JSON.stringify({ test: { runner: { command: [process.execPath, "-e", "process.exit(0)"] }, prerequisites: [{ command: [process.execPath, script] }], worktreeDirectory: join(root, "test-worktrees") } }));
    const ingest = await (await api.post("/reviews/ingest", { pr: "42" })).json();
    await waitUntil(() => existsSync(join(root, "test-pid")));
    assert.equal(getReview("42")?.status, "pending");
    const pid = Number(readFileSync(join(root, "test-pid"), "utf8"));
    const directory = getReview("42")!.metadataDirectory!;
    assert.equal((await fetch(`${api.url}/reviews?review=42`, { method: "DELETE", headers: { origin: "http://localhost:3000" } })).status, 200);
    await waitUntil(() => !alive(pid));
    assert.equal((await api.waitForJob(ingest.jobId)).status, "cancelled");
    assert.equal(getReview("42"), null);
    assert.equal(existsSync(directory), false);
  } finally { await api.stop(); }
}, 20_000);


test("a revision job still resolving its ID cannot recreate a review deleted after launch", async () => {
  const { root, base, head } = fixture(); const api = await running(root);
  try {
    const rev = `${base}...${head}`;
    const captured = await (await api.post("/reviews/capture", { rev })).json();
    const initial = await api.waitForJob(captured.jobId);
    assert.equal(initial.status, "ready");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(root, "bin/git"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const run=()=>{const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);};if(args[0]==='rev-parse'&&args.includes('--verify')){fs.writeFileSync(${JSON.stringify(join(root, "resolving"))},'');setTimeout(run,700);}else run();`, { mode: 0o755 });
    const job = await (await api.post("/reviews/capture", { rev: "HEAD~1...HEAD" })).json();
    await waitUntil(() => existsSync(join(root, "resolving")));
    assert.equal((await fetch(`${api.url}/reviews?review=${encodeURIComponent(initial.result.id)}`, { method: "DELETE", headers: { origin: "http://localhost:3000" } })).status, 200);
    assert.equal((await api.waitForJob(job.jobId)).status, "cancelled");
    assert.equal(getReview(initial.result.id), null);
    assert.equal(existsSync(initial.result.metadataDirectory), false);
  } finally { await api.stop(); }
}, 20_000);


test("refresh recaptures changed head or base revisions, retaining the original agent or the legacy default", async () => {
  const { root, base, head } = fixture(); const api = await running(root);
  try {
    const accepted = await (await api.post("/reviews/prepare", { number: 42, agent: "codex" })).json();
    assert.equal((await api.waitForJob(accepted.jobId)).status, "ready");
    assert.equal(getReview("42")?.agentId, "codex");
    // Both agents are ready, but the newly preferred Claude must not replace the original Codex.
    const claude = readFileSync(join(root, "bin/codex"), "utf8").replace("if (args[0] !== 'exec') process.exit(0);", "if (args[0] === '--version') process.exit(0); if (args[0] === 'auth') {console.log(JSON.stringify({loggedIn:true}));process.exit(0);}");
    writeFileSync(join(root, "bin/claude"), claude, { mode: 0o755 });
    writeFileSync(join(root, ".heptapod.json"), JSON.stringify({ agents: { preferenceOrder: ["claude", "codex"] } }));
    writeFileSync(join(root, "sample.txt"), "latest\n");
    execFileSync("git", ["add", "sample.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "latest PR revision"], { cwd: root });
    const latest = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const ghPath = join(root, "bin/gh");
    writeFileSync(ghPath, readFileSync(ghPath, "utf8").replaceAll(head, latest));
    const refreshed = await api.post("/reviews/42/refresh", {});
    assert.equal(refreshed.status, 202);
    assert.equal(getReview("42")?.status, "preparing");
    assert.equal(getReview("42")?.payload?.source.head, head);
    assert.equal((await api.post("/reviews/42/refresh", {})).status, 409);
    const refreshedJob = await api.waitForJob((await refreshed.json()).jobId);
    assert.equal(refreshedJob.status, "ready", refreshedJob.error);
    assert.equal(getReview("42")?.payload?.source.head, latest);
    assert.equal(getReview("42")?.agentId, "codex");
    assert.deepEqual(readFileSync(join(root, "agent-used"), "utf8").trim().split("\n"), ["codex", "codex"]);
    assert.equal(existsSync(join(root, "node_modules/.cache/heptapod/runs/42/history")), true);
    // A base-only change also recaptures, using the default when provenance is missing.
    writeFileSync(ghPath, readFileSync(ghPath, "utf8").replaceAll(base, head));
    const db = new DatabaseSync(process.env.HEPTAPOD_DB!);
    db.prepare("UPDATE reviews SET agent_id = NULL WHERE id = ?").run("42"); db.close();
    const legacy = await api.post("/reviews/42/refresh", {});
    assert.equal(legacy.status, 202);
    const legacyJob = await api.waitForJob((await legacy.json()).jobId);
    assert.equal(legacyJob.status, "ready", legacyJob.error);
    assert.equal(getReview("42")?.payload?.source.base, head);
    assert.equal(getReview("42")?.payload?.source.head, latest);
    assert.equal(getReview("42")?.agentId, "claude");
    assert.deepEqual(readFileSync(join(root, "agent-used"), "utf8").trim().split("\n"), ["codex", "codex", "claude"]);
  } finally { await api.stop(); }
}, 20_000);

test("unchanged refresh reruns tests without an agent or capture and preserves the authored metadata", async () => {
  const { root } = fixture(); const api = await running(root);
  try {
    const initial = await (await api.post("/reviews/prepare", { number: 42, agent: "codex" })).json();
    assert.equal((await api.waitForJob(initial.jobId)).status, "ready");
    const directory = getReview("42")!.metadataDirectory!;
    const paths = ["narrative.json", "source.diff", "steps/change.md", "diffs/change.diff"];
    const originals = paths.map((path) => readFileSync(join(directory, path), "utf8"));
    // The shortcut must not even probe agent availability.
    for (const agent of ["codex", "claude"]) writeFileSync(join(root, `bin/${agent}`), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, "agent-probed"))},'');process.exit(1);`, { mode: 0o755 });
    const runs = join(root, "test-runs");
    const config = (exitCode: number) => writeFileSync(join(root, ".heptapod.json"), JSON.stringify({ test: {
      runner: { command: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(runs)},'run\\n');process.exit(${exitCode});`] },
      worktreeDirectory: join(root, "test-worktrees"),
    } }));
    for (const [index, exitCode] of [0, 1].entries()) {
      config(exitCode);
      const response = await api.post("/reviews/42/refresh", {});
      assert.equal(response.status, 202);
      const job = await api.waitForJob((await response.json()).jobId);
      assert.equal(job.status, "ready", job.error);
      assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, index + 1);
      assert.equal(getReview("42")?.payload?.steps.at(-1)?.testRun?.status, exitCode === 0 ? "passing" : "failing");
      assert.deepEqual(paths.map((path) => readFileSync(join(directory, path), "utf8")), originals);
      assert.equal(existsSync(join(directory, "history")), false);
      assert.equal(existsSync(join(root, "agent-probed")), false);
      assert.equal(getReview("42")?.agentId, "codex");
    }
  } finally { await api.stop(); }
}, 20_000);

test("unchanged refresh prepares again when cached metadata is missing", async () => {
  const { root } = fixture(); const api = await running(root);
  try {
    const initial = await (await api.post("/reviews/prepare", { number: 42, agent: "codex" })).json();
    assert.equal((await api.waitForJob(initial.jobId)).status, "ready");
    rmSync(join(getReview("42")!.metadataDirectory!, "narrative.json"));
    const response = await api.post("/reviews/42/refresh", {});
    assert.equal(response.status, 202);
    const job = await api.waitForJob((await response.json()).jobId);
    assert.equal(job.status, "ready", job.error);
    assert.deepEqual(readFileSync(join(root, "agent-used"), "utf8").trim().split("\n"), ["codex", "codex"]);
  } finally { await api.stop(); }
}, 20_000);

test("large completed review payloads finish their IPC handoff before the worker exits", async () => {
  const { root } = fixture();
  const agent = join(root, "bin/codex");
  writeFileSync(agent, readFileSync(agent, "utf8").replace("'The sample changes.'", "'Review details. '.repeat(300000)"));
  const api = await running(root);
  try {
    const accepted = await (await api.post("/reviews/prepare", { number: 42, agent: "codex" })).json();
    const job = await api.waitForJob(accepted.jobId);
    assert.equal(job.status, "ready", job.error);
    assert.ok(job.result.payload.steps[1].body.length > 4_000_000);
    await delay(200);
    assert.equal(getReview("42")?.status, "ready");
    assert.equal((await (await fetch(`${api.url}/jobs/${encodeURIComponent(accepted.jobId)}`)).json()).status, "ready");
  } finally { await api.stop(); }
}, 20_000);
