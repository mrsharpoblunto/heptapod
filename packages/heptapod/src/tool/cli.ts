#!/usr/bin/env node
import { captureNarrative } from "./capture.js";
import {
  resolveDatabasePath,
  resolveReviewNarrativePath,
  resolveReviewRunDirectory,
} from "./cache.js";
import { repositoryRoot } from "./git.js";
import { ingestNarrative } from "./ingest.js";
import { loadManifest } from "./manifest.js";
import { resolvePullRequest, resolveRevisionRange, type ReviewSourceSelection } from "./review-source.js";
import { verifyNarrative } from "./verify.js";

function usage(): string {
  return `heptapod

Usage:
  heptapod capture --pr <number>
  heptapod capture --rev <base>...<target>
  heptapod validate --id <review-id>
  heptapod ingest --pr <number> [--site-url <url>]
  heptapod ingest --rev <base>...<target> [--site-url <url>]

Commands:
  capture   Pin base/head commits and create source.diff plus an artifact scaffold.
  validate  Apply every step patch in order and prove an exact source-diff match.
  ingest    Validate first, then upsert the review payload into SQLite.
`;
}

function parseArguments(argv: string[]): { command: string | undefined; options: Record<string, string> } {
  const [command, ...tokens] = argv;
  const options: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = tokens[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[key] = value;
  }
  return { command, options };
}

function required(options: Record<string, string>, name: string): string {
  if (!options[name]) throw new Error(`--${name} is required`);
  return options[name];
}

function printResult(label: string, result: unknown): void {
  process.stdout.write(`${label}\n${JSON.stringify(result, null, 2)}\n`);
}

function sourceSelection(repo: string, options: Record<string, string>): ReviewSourceSelection {
  if (options.pr && options.rev) throw new Error("Use either --pr or --rev, not both.");
  if (options.pr) return resolvePullRequest(repo, options.pr);
  if (options.rev) return resolveRevisionRange(repo, options.rev);
  throw new Error("Either --pr or --rev is required.");
}

try {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    process.exit(0);
  }

  if (options.repo) throw new Error("--repo is not supported; run heptapod from the target repository.");
  if (options.database) throw new Error("--database is not supported; Heptapod uses the repository-local cache automatically.");
  const repo = repositoryRoot();
  process.env.HEPTAPOD_ROOT ??= repo;
  if (command === "capture") {
    const source = sourceSelection(repo, options);
    const result = captureNarrative(
      repo,
      source.base,
      source.head,
      options["output-dir"] ?? resolveReviewRunDirectory(source.id),
      { githubPrUrl: source.githubPrUrl },
    );
    printResult("Captured source diff and scaffold.", { id: source.id, ...result });
  } else if (command === "validate") {
    const id = required(options, "id");
    const narrativePath = options.narrative ?? resolveReviewNarrativePath(id);
    const { manifest, manifestPath } = loadManifest(narrativePath, repo);
    const verification = verifyNarrative(repo, manifest, manifestPath);
    printResult("Exact reconstruction verified.", { id, narrative: manifestPath, ...verification });
  } else if (command === "ingest") {
    const source = sourceSelection(repo, options);
    const narrativePath = options.narrative ?? resolveReviewNarrativePath(source.id);
    const { manifest } = loadManifest(narrativePath, repo);
    if (manifest.source.base !== source.base || manifest.source.head !== source.head) {
      throw new Error(`Cached narrative ${source.id} does not match the selected source revisions; capture and author it again.`);
    }
    const review = ingestNarrative({
      id: source.id,
      repo,
      narrativePath,
      siteUrl: options["site-url"],
      collectRemoteEvidence: true,
      onTestProgress: (message) => process.stderr.write(`${message}\n`),
    });
    printResult("Exact reconstruction verified and review ingested.", {
      id: review.id,
      title: review.title,
      base: review.baseRevision,
      head: review.headRevision,
      updatedAt: review.updatedAt,
      database: resolveDatabasePath(),
      url: review.url,
    });
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = error instanceof Error && "exitCode" in error && typeof error.exitCode === "number"
    ? error.exitCode
    : 1;
  process.stderr.write(`heptapod: ${message}\n`);
  process.exit(exitCode);
}
