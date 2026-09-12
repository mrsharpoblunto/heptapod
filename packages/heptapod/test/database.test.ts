import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "vitest";
import { beginReviewIngestion, getReview, updateReviewIngestion } from "../src/tool/database.js";

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
