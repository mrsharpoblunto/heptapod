#!/usr/bin/env node
import { captureReview, validateReview, ingestReview } from "@thestraylight/heptapod-core/commands";
import { prepareReview } from "@thestraylight/heptapod-core/prepare";
import { resolveDatabasePath } from "@thestraylight/heptapod-core/cache";
import { repositoryRoot } from "@thestraylight/heptapod-core/git";

function usage(): string {
  return `heptapod

Usage:
  heptapod capture --pr <number>
  heptapod capture --rev <base>...<target>
  heptapod prepare --pr <number> --agent <codex|claude>
  heptapod validate --id <review-id>
  heptapod ingest --pr <number> [--site-url <url>]
  heptapod ingest --rev <base>...<target> [--site-url <url>]

Commands:
  capture   Pin base/head commits and create source.diff plus an artifact scaffold.
  prepare   Capture, ask an authenticated agent to author metadata, validate, and ingest.
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
    printResult("Captured source diff and scaffold.", captureReview(repo, options, options["output-dir"]));
  } else if (command === "prepare") {
    printResult("Review prepared and ingested.", await prepareReview(repo, required(options, "pr"), required(options, "agent")));
  } else if (command === "validate") {
    printResult("Exact reconstruction verified.", validateReview(repo, required(options, "id"), options.narrative));
  } else if (command === "ingest") {
    const review = ingestReview(repo, options, {
      narrativePath: options.narrative,
      siteUrl: options["site-url"],
      onProgress: (message) => process.stderr.write(`${message}\n`),
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
