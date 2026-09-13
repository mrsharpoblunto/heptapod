import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot, resolveCommit } from "./git.js";
import { run } from "./process.js";
import type { RenderModel } from "./types.js";

/** Persistent editor checkouts are separate from the mutable, temporary test worktree. */
export function ensureRevisionCheckout(repo: string, revision: string): string {
  const root = repositoryRoot(repo);
  const commit = resolveCommit(root, revision);
  const directory = join(root, "node_modules/.cache/heptapod/checkouts");
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${commit}-`)) continue;
    const candidate = join(directory, entry.name);
    try {
      if (resolve(repositoryRoot(candidate)) !== resolve(candidate) || resolveCommit(candidate, "HEAD") !== commit) continue;
      const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: candidate });
      if (!status.stdout.length) return candidate;
    } catch {
      // A removed or incomplete worktree cannot be reused.
    }
  }
  // Keep edits made through the editor; create a fresh checkout instead of resetting them.
  const checkout = mkdtempSync(join(directory, `${commit}-`));
  const hooks = join(directory, "empty-hooks");
  mkdirSync(hooks, { recursive: true });
  try {
    run("git", ["-c", `core.hooksPath=${hooks}`, "worktree", "add", "--detach", checkout, commit], { cwd: root });
    return checkout;
  } catch (error) {
    rmSync(checkout, { recursive: true, force: true });
    throw error;
  }
}

function regularFiles(repo: string, revision: string): Set<string> {
  const tree = run("git", ["ls-tree", "-r", "-z", revision], { cwd: repo }).stdout.toString("utf8");
  // Exclude symlinks and submodules: they do not identify a regular file at this revision.
  return new Set(tree.split("\0").flatMap((entry) => {
    const tab = entry.indexOf("\t");
    return /^100(644|755) blob /.test(entry) && tab !== -1 ? [entry.slice(tab + 1)] : [];
  }));
}

export function buildEditorLinks(repo: string, model: RenderModel): NonNullable<RenderModel["editorLinks"]> {
  repo = repositoryRoot(repo);
  const revisions = { head: model.source.head, base: model.source.base };
  const files = { head: regularFiles(repo, revisions.head), base: regularFiles(repo, revisions.base) };
  const checkouts: Partial<Record<"head" | "base", string>> = {};
  const paths = new Set([
    ...(model.source.files ?? []).map((file) => file.path),
    ...model.steps.flatMap((step) => [...step.fileDiffs, ...(step.referenceFiles ?? [])].map((file) => file.path)),
  ]);
  return Object.fromEntries([...paths].flatMap((path) => {
    const side = files.head.has(path) ? "head" : files.base.has(path) ? "base" : undefined;
    if (!side) return [];
    const checkout = checkouts[side] ??= ensureRevisionCheckout(repo, revisions[side]);
    const url = `vscode://file${pathToFileURL(join(checkout, path)).pathname}`;
    return [[path, { url, revision: revisions[side], side }]];
  }));
}
