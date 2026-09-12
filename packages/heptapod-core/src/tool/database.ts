import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { resolveDatabasePath, validateReviewId } from "./cache.js";
import { validateReviewComments } from "./review-draft.js";
import type { AgentId } from "./agents.js";
import type { RenderModel, ReviewComment, ReviewDraft } from "./types.js";

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
  status: "preparing" | "pending" | "ready" | "failed";
  progress: string | null;
  error: string | null;
  metadataDirectory: string | null;
  agentId: AgentId | null;
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
  metadata_directory: string | null;
  agent_id: AgentId | null;
  payload_json: string;
  status: "preparing" | "pending" | "ready" | "failed";
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
  if (!columns.has("agent_id")) database.exec("ALTER TABLE reviews ADD COLUMN agent_id TEXT;");
  if (!columns.has("metadata_directory")) database.exec("ALTER TABLE reviews ADD COLUMN metadata_directory TEXT;");
  if (!columns.has("status")) database.exec("ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';");
  if (!columns.has("progress")) database.exec("ALTER TABLE reviews ADD COLUMN progress TEXT;");
  if (!columns.has("error")) database.exec("ALTER TABLE reviews ADD COLUMN error TEXT;");
  database.exec(`CREATE TABLE IF NOT EXISTS review_drafts (
    review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    head TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    summary_is_combined INTEGER NOT NULL DEFAULT 0,
    comments_json TEXT NOT NULL DEFAULT '[]',
    github_review_id TEXT,
    github_url TEXT,
    published_at TEXT,
    publishing_until INTEGER NOT NULL DEFAULT 0
  ) STRICT;`);
  const draftColumns = new Set((database.prepare("PRAGMA table_info(review_drafts)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!draftColumns.has("summary_is_combined")) database.exec("ALTER TABLE review_drafts ADD COLUMN summary_is_combined INTEGER NOT NULL DEFAULT 0");
  return database;
}

interface DraftRow {
  review_id: string;
  id: string;
  head: string;
  version: number;
  summary: string;
  summary_is_combined: number;
  comments_json: string;
  github_review_id: string | null;
  github_url: string | null;
  published_at: string | null;
  publishing_until: number;
}

function draftFromDatabase(database: DatabaseSync, reviewId: string): ReviewDraft {
  const row = database.prepare("SELECT * FROM review_drafts WHERE review_id = ?").get(reviewId) as DraftRow | undefined;
  if (!row) throw new Error("The review draft was not found.");
  return { id: row.id, reviewId: row.review_id, head: row.head, version: row.version, summary: row.summary,
    summaryIsCombined: Boolean(row.summary_is_combined), comments: JSON.parse(row.comments_json), githubReviewId: row.github_review_id, githubUrl: row.github_url,
    publishedAt: row.published_at, publishing: row.publishing_until > Date.now() };
}

function requireGitHubReview(database: DatabaseSync, id: string): ReadyStoredReview {
  const review = getReviewFromDatabase(database, id);
  if (!review?.payload?.source.github) throw new Error("Review drafts are only available for GitHub pull requests.");
  if (review.status !== "ready") throw new Error("Wait for the review to finish loading.");
  return review as ReadyStoredReview;
}

export function getReviewDraft(reviewId: string, databasePath?: string): ReviewDraft {
  validateReviewId(reviewId);
  const database = openDatabase(databasePath);
  try {
    const review = requireGitHubReview(database, reviewId);
    database.prepare("INSERT OR IGNORE INTO review_drafts (review_id, id, head) VALUES (?, ?, ?)").run(reviewId, randomUUID(), review.headRevision);
    return draftFromDatabase(database, reviewId);
  } finally { database.close(); }
}

export function saveReviewDraft(reviewId: string, version: number, summary: string, comments: ReviewComment[], databasePath?: string, summaryIsCombined = false): ReviewDraft {
  const database = openDatabase(databasePath);
  try {
    const review = requireGitHubReview(database, reviewId);
    validateReviewComments(review.payload, summary, comments);
    const result = database.prepare(`UPDATE review_drafts SET summary = ?, summary_is_combined = ?, comments_json = ?, version = version + 1
      WHERE review_id = ? AND version = ? AND head = ? AND publishing_until < ? AND github_review_id IS NULL AND published_at IS NULL`)
      .run(summary, summaryIsCombined ? 1 : 0, JSON.stringify(comments), reviewId, version, review.headRevision, Date.now());
    if (!result.changes) throw new Error("This draft changed in another tab, is being published, or belongs to an older revision. Reload before editing.");
    return draftFromDatabase(database, reviewId);
  } finally { database.close(); }
}

export function claimReviewDraftPublication(reviewId: string, version: number, databasePath?: string): ReviewDraft {
  const database = openDatabase(databasePath);
  try {
    const review = requireGitHubReview(database, reviewId);
    const draft = draftFromDatabase(database, reviewId);
    if (draft.publishedAt) return draft;
    const result = database.prepare(`UPDATE review_drafts SET publishing_until = ?
      WHERE review_id = ? AND version = ? AND head = ? AND publishing_until < ?`)
      .run(Date.now() + 10 * 60_000, reviewId, version, review.headRevision, Date.now());
    if (!result.changes) throw new Error("This draft changed or is already being published. Reload and try again.");
    return draftFromDatabase(database, reviewId);
  } finally { database.close(); }
}

export function recordGitHubDraft(reviewId: string, githubReviewId: string, githubUrl: string, databasePath?: string): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare("UPDATE review_drafts SET github_review_id = ?, github_url = ?, publishing_until = ? WHERE review_id = ?")
      .run(githubReviewId, githubUrl, Date.now() + 10 * 60_000, reviewId);
  } finally { database.close(); }
}

export function finishReviewDraftPublication(reviewId: string, success: boolean, databasePath?: string): ReviewDraft {
  const database = openDatabase(databasePath);
  try {
    database.prepare("UPDATE review_drafts SET publishing_until = 0, published_at = COALESCE(?, published_at) WHERE review_id = ?")
      .run(success ? new Date().toISOString() : null, reviewId);
    return draftFromDatabase(database, reviewId);
  } finally { database.close(); }
}

export interface PreparationDetails {
  title: string;
  sourceUrl?: string;
  baseRevision?: string;
  headRevision?: string;
  metadataDirectory: string;
  agentId?: AgentId;
}

// INSERT OR IGNORE makes the web launch claim atomic across requests/processes.
export function beginReviewPreparation(id: string, details: PreparationDetails, databasePath?: string, claimOnly = false): boolean {
  validateReviewId(id);
  const database = openDatabase(databasePath);
  const now = new Date().toISOString();
  try {
    const result = database.prepare(`INSERT INTO reviews
      (id, title, summary, source_url, base_revision, head_revision, payload_json,
       created_at, updated_at, status, progress, metadata_directory, agent_id)
      VALUES (?, ?, '', ?, ?, ?, 'null', ?, ?, 'preparing', 'Preparing review', ?, ?)
      ON CONFLICT(id) DO ${claimOnly ? "NOTHING" : `UPDATE SET
        title = excluded.title, source_url = excluded.source_url,
        base_revision = excluded.base_revision, head_revision = excluded.head_revision,
        updated_at = excluded.updated_at, status = 'preparing', progress = 'Preparing review',
        metadata_directory = excluded.metadata_directory, agent_id = COALESCE(excluded.agent_id, reviews.agent_id), error = NULL`}`)
      .run(id, details.title, details.sourceUrl ?? null, details.baseRevision ?? "", details.headRevision ?? "", now, now, details.metadataDirectory, details.agentId ?? null);
    return result.changes > 0;
  } finally { database.close(); }
}

export function beginReviewUpdate(id: string, databasePath?: string): boolean {
  validateReviewId(id);
  const database = openDatabase(databasePath);
  try {
    return database.prepare(`UPDATE reviews SET status = 'preparing', progress = 'Checking for PR changes', error = NULL, updated_at = ?
      WHERE id = ? AND payload_json != 'null' AND status NOT IN ('preparing', 'pending')`)
      .run(new Date().toISOString(), id).changes > 0;
  } finally { database.close(); }
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
    metadataDirectory: row.metadata_directory,
    agentId: row.agent_id,
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
