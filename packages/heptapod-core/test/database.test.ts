import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { beginReviewPreparation, beginReviewIngestion, beginReviewUpdate, failReviewIngestion, getReview, listReviews, updateReviewIngestion, upsertReview } from "../src/tool/database.js";
import type { RenderModel } from "../src/tool/types.js";

test("review order stays stable through imports and refreshes, including tied creation times", () => {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-db-order-"));
  const databasePath = join(directory, "reviews.sqlite");
  const details = { title: "Review", summary: "Test", baseRevision: "base", headRevision: "head", metadataDirectory: directory };
  const payload: RenderModel = {
    title: details.title, summary: details.summary,
    source: { base: "base", head: "head", diff: "source.diff", files: [] },
    verification: { base: "base", head: "head", tree: "tree", sourceBytes: 0, patchSteps: 0, exact: true },
    steps: [],
  };
  const ids = () => listReviews(databasePath).map((review) => review.id);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    beginReviewPreparation("1", details, databasePath);
    vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
    beginReviewPreparation("3", details, databasePath);
    beginReviewPreparation("2", details, databasePath);
    assert.deepEqual(ids(), ["2", "3", "1"]);

    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
    beginReviewIngestion("1", details, databasePath);
    assert.deepEqual(ids(), ["2", "3", "1"]);
    updateReviewIngestion("3", "Running tests", databasePath);
    assert.deepEqual(ids(), ["2", "3", "1"]);
    upsertReview("1", payload, databasePath);
    assert.deepEqual(ids(), ["2", "3", "1"]);
    assert.equal(beginReviewUpdate("1", databasePath), true);
    assert.deepEqual(ids(), ["2", "3", "1"]);
    failReviewIngestion("1", "Update failed", databasePath);
    assert.deepEqual(ids(), ["2", "3", "1"]);

    beginReviewPreparation("4", details, databasePath);
    assert.deepEqual(ids(), ["4", "2", "3", "1"]);
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

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
