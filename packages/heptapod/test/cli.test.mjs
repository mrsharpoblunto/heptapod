import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getReview } from "@thestraylight/heptapod-core/database";

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
