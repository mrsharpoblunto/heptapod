import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "./process.js";
import type { ChangedFile } from "./types.js";

export const DIFF_ARGS = [
  "--binary",
  "--full-index",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--find-renames=50%",
];

export function repositoryRoot(repo = "."): string {
  const cwd = resolve(repo ?? ".");
  return run("git", ["rev-parse", "--show-toplevel"], { cwd }).stdout.toString("utf8").trim();
}

export function resolveCommit(repo: string, ref: string): string {
  return run("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repo,
  }).stdout.toString("utf8").trim();
}

export function resolveTree(repo: string, ref: string): string {
  return run("git", ["rev-parse", "--verify", `${ref}^{tree}`], {
    cwd: repo,
  }).stdout.toString("utf8").trim();
}

export function canonicalDiff(repo: string, base: string, head: string): Buffer {
  return run("git", ["diff", ...DIFF_ARGS, base, head, "--"], { cwd: repo }).stdout;
}

export function changedFiles(repo: string, base: string, head: string): ChangedFile[] {
  const output = run(
    "git",
    ["diff", "--name-status", "-z", "--find-renames=50%", base, head, "--"],
    { cwd: repo },
  ).stdout;
  const fields = output.toString("utf8").split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++];
    if (status === undefined) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[index++];
      const path = fields[index++];
      if (from === undefined || path === undefined) break;
      files.push({ status, from, path });
    } else {
      const path = fields[index++];
      if (path === undefined) break;
      files.push({ status, path });
    }
  }
  return files;
}

export function withTemporaryIndex<T>(
  repo: string,
  base: string,
  callback: (index: { env: NodeJS.ProcessEnv; indexPath: string }) => T,
): T {
  const tempDirectory = mkdtempSync(join(tmpdir(), "heptapod-"));
  const indexPath = join(tempDirectory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    run("git", ["read-tree", base], { cwd: repo, env });
    return callback({ env, indexPath });
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export function applyPatchToIndex(
  repo: string,
  env: NodeJS.ProcessEnv,
  patch: Buffer,
  label: string,
): void {
  const result = run(
    "git",
    ["apply", "--cached", "--binary", "--whitespace=nowarn", "--recount", "-"],
    { cwd: repo, env, input: patch, allowFailure: true },
  );
  if (result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
    throw new Error(`Step patch ${label} does not apply to the preceding steps${detail ? `:\n${detail}` : "."}`);
  }
}

export function stagedTree(repo: string, env: NodeJS.ProcessEnv): string {
  return run("git", ["write-tree"], { cwd: repo, env }).stdout.toString("utf8").trim();
}

export function stagedDiff(repo: string, env: NodeJS.ProcessEnv, base: string): Buffer {
  return run("git", ["diff", "--cached", ...DIFF_ARGS, base, "--"], { cwd: repo, env }).stdout;
}
