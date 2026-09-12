import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath, validateReviewId } from "./cache.js";
import type { RenderModel } from "./types.js";

export { resolveDatabasePath, validateReviewId } from "./cache.js";

export interface StoredReview {
  id: string;
  title: string;
  summary: string;
  sourceUrl: string | null;
  baseRevision: string;
  headRevision: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "ready" | "failed";
  progress: string | null;
  error: string | null;
  payload: RenderModel | null;
}

export interface ReadyStoredReview extends StoredReview {
  status: "ready";
  payload: RenderModel;
}

interface ReviewRow {
  id: string;
  title: string;
  summary: string;
  source_url: string | null;
  base_revision: string;
  head_revision: string;
  created_at: string;
  updated_at: string;
  payload_json: string;
  status: "pending" | "ready" | "failed";
  progress: string | null;
  error: string | null;
}

function openDatabase(databasePath?: string): DatabaseSync {
  const path = resolveDatabasePath(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_url TEXT,
      base_revision TEXT NOT NULL,
      head_revision TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      progress TEXT,
      error TEXT
    ) STRICT;
  `);
  const columns = new Set(
    (database.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("status")) database.exec("ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';");
  if (!columns.has("progress")) database.exec("ALTER TABLE reviews ADD COLUMN progress TEXT;");
  if (!columns.has("error")) database.exec("ALTER TABLE reviews ADD COLUMN error TEXT;");
  return database;
}

export function beginReviewIngestion(
  id: string,
  details: { title: string; summary: string; sourceUrl?: string; baseRevision: string; headRevision: string },
  databasePath?: string,
): StoredReview {
  validateReviewId(id);
  const database = openDatabase(databasePath);
  const now = new Date().toISOString();
  try {
    database.prepare(`
      INSERT INTO reviews (
        id, title, summary, source_url, base_revision, head_revision,
        payload_json, created_at, updated_at, status, progress, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        source_url = excluded.source_url,
        base_revision = excluded.base_revision,
        head_revision = excluded.head_revision,
        updated_at = excluded.updated_at,
        status = 'pending',
        progress = excluded.progress,
        error = NULL
    `).run(
      id,
      details.title,
      details.summary,
      details.sourceUrl ?? null,
      details.baseRevision,
      details.headRevision,
      "null",
      now,
      now,
      "Preparing ingestion",
    );
    const review = getReviewFromDatabase(database, id);
    if (!review) throw new Error(`Pending review ${id} was not stored.`);
    return review;
  } finally {
    database.close();
  }
}

export function updateReviewIngestion(id: string, progress: string, databasePath?: string): void {
  validateReviewId(id);
  const database = openDatabase(databasePath);
  try {
    database.prepare("UPDATE reviews SET status = 'pending', progress = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(progress, new Date().toISOString(), id);
  } finally {
    database.close();
  }
}

export function failReviewIngestion(id: string, error: string, databasePath?: string): void {
  validateReviewId(id);
  const database = openDatabase(databasePath);
  try {
    database.prepare("UPDATE reviews SET status = 'failed', progress = NULL, error = ?, updated_at = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
  } finally {
    database.close();
  }
}

export function upsertReview(id: string, payload: RenderModel, databasePath?: string): ReadyStoredReview {
  validateReviewId(id);
  const database = openDatabase(databasePath);
  const now = new Date().toISOString();
  try {
    database.prepare(`
      INSERT INTO reviews (
        id, title, summary, source_url, base_revision, head_revision,
        payload_json, created_at, updated_at, status, progress, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'Complete', NULL)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        source_url = excluded.source_url,
        base_revision = excluded.base_revision,
        head_revision = excluded.head_revision,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        status = 'ready',
        progress = 'Complete',
        error = NULL
    `).run(
      id,
      payload.title,
      payload.summary,
      payload.source.github?.pullRequestUrl ?? null,
      payload.source.base,
      payload.source.head,
      JSON.stringify(payload),
      now,
      now,
    );
    const review = getReviewFromDatabase(database, id);
    if (!review) throw new Error(`Review ${id} was not stored.`);
    return review as ReadyStoredReview;
  } finally {
    database.close();
  }
}

function rowToReview(row: ReviewRow): StoredReview {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    sourceUrl: row.source_url,
    baseRevision: row.base_revision,
    headRevision: row.head_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    progress: row.progress,
    error: row.error,
    payload: JSON.parse(row.payload_json) as RenderModel | null,
  };
}

function getReviewFromDatabase(database: DatabaseSync, id: string): StoredReview | null {
  const row = database.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as
    | ReviewRow
    | undefined;
  return row ? rowToReview(row) : null;
}

export function getReview(id: string, databasePath?: string): StoredReview | null {
  validateReviewId(id);
  const database = openDatabase(databasePath);
  try {
    return getReviewFromDatabase(database, id);
  } finally {
    database.close();
  }
}

export function listReviews(databasePath?: string): StoredReview[] {
  const database = openDatabase(databasePath);
  try {
    const rows = database
      .prepare("SELECT * FROM reviews ORDER BY updated_at DESC")
      .all() as unknown as ReviewRow[];
    return rows.map(rowToReview);
  } finally {
    database.close();
  }
}

export function deleteReview(id: string, databasePath?: string): boolean {
  validateReviewId(id);
  const database = openDatabase(databasePath);
  try {
    return database.prepare("DELETE FROM reviews WHERE id = ?").run(id).changes > 0;
  } finally {
    database.close();
  }
}
