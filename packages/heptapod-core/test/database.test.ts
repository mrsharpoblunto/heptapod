import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { beginReviewPreparation, beginReviewIngestion, getReview, updateReviewIngestion } from "../src/tool/database.js";

test("ingestion waits for a concurrent viewer database transaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-db-lock-"));
  const databasePath = join(directory, "reviews.sqlite");
  beginReviewIngestion("68", { title: "Review", summary: "Test", baseRevision: "base", headRevision: "head" }, databasePath);
  const locker = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('BEGIN IMMEDIATE;');
    process.stdout.write('locked');
    setTimeout(() => { database.exec('COMMIT;'); database.close(); }, 200);
  `, databasePath], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(locker, "exit");
  try {
    await once(locker.stdout, "data");
    updateReviewIngestion("68", "Built successfully", databasePath);
    assert.equal(getReview("68", databasePath)?.progress, "Built successfully");
    assert.equal((await exited)[0], 0);
  } finally {
    if (locker.exitCode === null) locker.kill();
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates existing reviews and atomically claims preparation without replacing a review", () => {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-db-migration-"));
  const path = join(directory, "reviews.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE reviews (id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, source_url TEXT,
      base_revision TEXT NOT NULL, head_revision TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      INSERT INTO reviews VALUES ('1', 'Existing', '', NULL, 'base', 'head', 'null', '2026-01-01', '2026-01-01');`);
    db.close();
    assert.equal(getReview("1", path)?.status, "ready");
    assert.equal(getReview("1", path)?.metadataDirectory, null);
    const details = { title: "Preparing", metadataDirectory: join(directory, "metadata") };
    assert.equal(beginReviewPreparation("1", details, path, true), false);
    assert.equal(getReview("1", path)?.title, "Existing");
    assert.equal(beginReviewPreparation("2", details, path, true), true);
    assert.equal(beginReviewPreparation("2", details, path, true), false);
    assert.equal(getReview("2", path)?.status, "preparing");
    beginReviewIngestion("2", { title: "Ingesting", summary: "", baseRevision: "base", headRevision: "head" }, path);
    assert.equal(getReview("2", path)?.status, "pending");
    assert.equal(getReview("2", path)?.metadataDirectory, details.metadataDirectory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
