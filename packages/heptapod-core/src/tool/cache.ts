import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PULL_REQUEST_ID = /^\d+$/;
const REVISION_ID = /^[a-f\d]{40}\/[a-f\d]{40}$/i;

export function validateReviewId(id: string): void {
  if (!PULL_REQUEST_ID.test(id) && !REVISION_ID.test(id)) {
    throw new Error("Review ID must be a pull-request number or <40-character-base>/<40-character-target>.");
  }
}

export function resolveCacheDirectory(): string {
  const projectRoot = resolve(/* turbopackIgnore: true */ process.env.HEPTAPOD_ROOT ?? process.cwd());
  return resolve(projectRoot, "node_modules/.cache/heptapod");
}

export function resolveDatabasePath(databasePath?: string): string {
  const configured = databasePath ?? process.env.HEPTAPOD_DB;
  if (configured) return resolve(/* turbopackIgnore: true */ configured);
  return resolve(resolveCacheDirectory(), "reviews.sqlite");
}

export function resolveReviewRunDirectory(id: string): string {
  return resolveReviewRunDirectoryForRoot(process.env.HEPTAPOD_ROOT ?? process.cwd(), id);
}

export function resolveReviewRunDirectoryForRoot(root: string, id: string): string {
  validateReviewId(id);
  return resolve(root, "node_modules/.cache/heptapod/runs", id);
}

export function resolveReviewNarrativePath(id: string): string {
  return resolve(resolveReviewRunDirectory(id), "narrative.json");
}

export function removeReviewRun(id: string): boolean {
  return removeReviewRunForRoot(process.env.HEPTAPOD_ROOT ?? process.cwd(), id);
}

export function removeReviewRunForRoot(root: string, id: string): boolean {
  const directory = resolveReviewRunDirectoryForRoot(root, id);
  if (!existsSync(directory)) return false;
  rmSync(directory, { recursive: true, force: true });
  if (id.includes("/")) {
    try {
      rmSync(dirname(directory));
    } catch {
      // Another comparison may share the same base revision directory.
    }
  }
  return true;
}
