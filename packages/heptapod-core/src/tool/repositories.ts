import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repositoryRoot } from "./git.js";
import { run } from "./process.js";
import { githubRepositoryFromRemote } from "./connected-repository.js";

export interface RegisteredRepository {
  id: string;
  root: string;
  name: string;
  githubUrl?: string;
  createdAt: string;
  updatedAt: string;
}

interface RepositoryRow {
  id: string;
  root: string;
  name: string;
  github_url: string | null;
  created_at: string;
  updated_at: string;
}

export function resolveHeptapodStateDirectory(): string {
  if (process.env.HEPTAPOD_STATE_DIR) return resolve(process.env.HEPTAPOD_STATE_DIR);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Heptapod");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Heptapod");
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "heptapod");
}

export function resolveRepositoryRegistryPath(): string {
  return resolve(/* turbopackIgnore: true */ process.env.HEPTAPOD_REGISTRY_DB ?? join(resolveHeptapodStateDirectory(), "repositories.sqlite"));
}

export function repositoryDatabasePath(id: string): string {
  if (!/^[a-f\d]{16}$/.test(id)) throw new Error("Invalid repository ID.");
  return join(resolveHeptapodStateDirectory(), "repositories", id, "reviews.sqlite");
}

function openRegistry(): DatabaseSync {
  const path = resolveRepositoryRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  database.exec(`CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    github_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`);
  return database;
}

function rowToRepository(row: RepositoryRow): RegisteredRepository {
  return {
    id: row.id,
    root: row.root,
    name: row.name,
    ...(row.github_url ? { githubUrl: row.github_url } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function githubRemote(root: string): { name: string; githubUrl?: string } {
  const fallback = { name: basename(root) };
  const remote = run("git", ["remote", "get-url", "origin"], { cwd: root, allowFailure: true });
  if (remote.status !== 0) return fallback;
  return githubRepositoryFromRemote(remote.stdout.toString("utf8")) ?? fallback;
}

export function registerRepository(path = "."): RegisteredRepository {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const root = realpathSync(repositoryRoot(expanded));
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const metadata = githubRemote(root);
  const database = openRegistry();
  const now = new Date().toISOString();
  try {
    database.prepare(`INSERT INTO repositories (id, root, name, github_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(root) DO UPDATE SET name = excluded.name, github_url = excluded.github_url, updated_at = excluded.updated_at`)
      .run(id, root, metadata.name, metadata.githubUrl ?? null, now, now);
    mkdirSync(dirname(repositoryDatabasePath(id)), { recursive: true });
    return getRepositoryFromDatabase(database, id)!;
  } finally { database.close(); }
}

function getRepositoryFromDatabase(database: DatabaseSync, id: string): RegisteredRepository | null {
  if (!/^[a-f\d]{16}$/.test(id)) return null;
  const row = database.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as RepositoryRow | undefined;
  return row ? rowToRepository(row) : null;
}

export function getRepository(id: string): RegisteredRepository | null {
  const database = openRegistry();
  try { return getRepositoryFromDatabase(database, id); }
  finally { database.close(); }
}

export function findRepository(path = "."): RegisteredRepository | null {
  const root = realpathSync(repositoryRoot(path));
  const database = openRegistry();
  try {
    const row = database.prepare("SELECT * FROM repositories WHERE root = ?").get(root) as RepositoryRow | undefined;
    return row ? rowToRepository(row) : null;
  } finally { database.close(); }
}

export function listRepositories(): RegisteredRepository[] {
  const database = openRegistry();
  try {
    return (database.prepare("SELECT * FROM repositories ORDER BY name COLLATE NOCASE, root").all() as unknown as RepositoryRow[]).map(rowToRepository);
  } finally { database.close(); }
}

/** Unregistering never deletes repository files or retained review data. */
export function removeRepository(id: string): boolean {
  if (!/^[a-f\d]{16}$/.test(id)) return false;
  const database = openRegistry();
  try { return database.prepare("DELETE FROM repositories WHERE id = ?").run(id).changes > 0; }
  finally { database.close(); }
}
