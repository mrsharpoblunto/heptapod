import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(packageRoot, "scripts/heptapod-skill.mjs");
const skillSource = join(packageRoot, "skills/heptapod");

function run(repo, command) {
  return spawnSync(process.execPath, [installer, command], {
    cwd: repo,
    encoding: "utf8",
  });
}

test("installs, reports, and safely removes both project skill links", () => {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-skill-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });

    const installed = run(repo, "install");
    assert.equal(installed.status, 0, installed.stderr);
    const codex = join(repo, ".agents/skills/heptapod");
    const claude = join(repo, ".claude/skills/heptapod");
    assert.equal(lstatSync(codex).isSymbolicLink(), true);
    assert.equal(lstatSync(claude).isSymbolicLink(), true);
    assert.equal(realpathSync(codex), realpathSync(skillSource));
    assert.equal(realpathSync(claude), realpathSync(skillSource));

    const repeated = run(repo, "install");
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /already linked/);

    const status = run(repo, "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Codex: linked/);
    assert.match(status.stdout, /Claude: linked/);

    const removed = run(repo, "uninstall");
    assert.equal(removed.status, 0, removed.stderr);
    assert.throws(() => lstatSync(codex), { code: "ENOENT" });
    assert.throws(() => lstatSync(claude), { code: "ENOENT" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("refuses to replace an existing skill", () => {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-skill-collision-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("mkdir", ["-p", join(repo, ".agents/skills/heptapod")]);
    const result = run(repo, "install");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to replace existing Codex skill/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
