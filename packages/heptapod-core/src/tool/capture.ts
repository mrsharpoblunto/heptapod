import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentId } from "./agents.js";
import { beginReviewPreparation } from "./database.js";
import { canonicalDiff, changedFiles, resolveCommit } from "./git.js";
import type { GitHubSource, NarrativeManifest } from "./types.js";

function writeNew(path: string, contents: string | Buffer): void {
  try {
    writeFileSync(path, contents, { flag: "wx" });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing artifact: ${path}`);
    }
    throw error;
  }
}

export function parseGitHubPullRequest(url: string): GitHubSource {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid GitHub pull-request URL: ${url}`);
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (parsed.hostname !== "github.com" || !match) {
    throw new Error(`Expected a GitHub pull-request URL, received: ${url}`);
  }
  const [, owner, repository, number] = match;
  if (!owner || !repository || !number) throw new Error(`Invalid GitHub pull-request URL: ${url}`);
  return {
    pullRequestUrl: `https://github.com/${owner}/${repository}/pull/${number}`,
    repositoryUrl: `https://github.com/${owner}/${repository}`,
    number: Number(number),
  };
}

export interface CaptureOptions {
  githubPrUrl?: string;
  agentId?: AgentId;
  databasePath?: string;
  title?: string;
}

export function captureNarrative(
  repo: string,
  baseRef: string,
  headRef: string,
  outputDirectory: string,
  options: CaptureOptions = {},
) {
  const output = resolve(outputDirectory);
  const base = resolveCommit(repo, baseRef);
  const head = resolveCommit(repo, headRef);
  const diff = canonicalDiff(repo, base, head);
  if (diff.length === 0) throw new Error(`There is no diff between ${baseRef} and ${headRef}.`);
  const files = changedFiles(repo, base, head);

  for (const path of [join(output, "source.diff"), join(output, "steps", "01-problem.md"), join(output, "narrative.json")]) {
    if (existsSync(path)) throw new Error(`Refusing to overwrite existing artifact: ${path}`);
  }
  mkdirSync(join(output, "steps"), { recursive: true });
  mkdirSync(join(output, "diffs"), { recursive: true });
  writeNew(join(output, "source.diff"), diff);
  writeNew(
    join(output, "steps", "01-problem.md"),
    "Explain the user-visible or engineering problem, why the current behavior is insufficient, and the high-level route through the change. This opening step intentionally has no diff.\n",
  );

  const manifest: NarrativeManifest = {
    schemaVersion: 1,
    title: `Parallel construction of ${basename(repo)}`,
    summary: "A step-by-step reconstruction of the change.",
    source: {
      base,
      head,
      diff: "source.diff",
      files,
      ...(options.githubPrUrl ? { github: parseGitHubPullRequest(options.githubPrUrl) } : {}),
    },
    steps: [
      {
        id: "problem-and-approach",
        title: "Understand the problem and approach",
        kind: "description",
        body: "steps/01-problem.md",
        checks: { automated: [], manual: [] },
      },
    ],
  };
  writeNew(join(output, "narrative.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const id = manifest.source.github ? String(manifest.source.github.number) : `${base}/${head}`;
  beginReviewPreparation(id, {
    title: options.title ?? (manifest.source.github ? `Pull request #${id}` : manifest.title),
    sourceUrl: manifest.source.github?.pullRequestUrl,
    baseRevision: base,
    headRevision: head,
    metadataDirectory: output,
    agentId: options.agentId,
  }, options.databasePath ?? process.env.HEPTAPOD_DB ?? join(repo, "node_modules/.cache/heptapod/reviews.sqlite"));
  return { id, output, metadataDirectory: output, narrative: join(output, "narrative.json"), base, head, files: files.length, sourceBytes: diff.length };
}
