#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getReview, listReviewsReadOnly } from "@thestraylight/heptapod-core/database";
import { captureReview, validateReview, ingestReview } from "@thestraylight/heptapod-core/commands";
import { prepareReview } from "@thestraylight/heptapod-core/prepare";
import { resolveDatabasePath } from "@thestraylight/heptapod-core/cache";
import { repositoryRoot } from "@thestraylight/heptapod-core/git";
import { apiUrl, ensureRemoteRepository, listRemoteRepositories, removeRemoteRepository, uploadReview } from "./client.js";
import { choosePullRequests, createIngestionProgress } from "./tui.js";
import { configureService, installService, runService, serviceStatus, startService, stopService } from "./service.js";

type OutputMode = "human" | "ndjson";
interface ParsedArguments { command?: string; action?: string; options: Record<string, string> }

function usage(): string {
  return `heptapod

Usage:
  heptapod [--service-port <port>] Select pull requests in an interactive terminal.
  heptapod capture --pr <number>
  heptapod capture --rev <base>...<target>
  heptapod prepare --pr <number> --agent <codex|claude>
  heptapod validate --id <review-id>
  heptapod ingest --pr <number> [--output ndjson] [--service-port <web-port>]
  heptapod ingest --rev <base>...<target> [--output ndjson] [--service-port <web-port>]
  heptapod repo add
  heptapod repo sync
  heptapod repo list
  heptapod repo remove [--id <repository-id>]
  heptapod service configure --port <port>
  heptapod service install|start|run|status|stop [--port <port>]

The service port is stored in the per-user Heptapod config. Use --service-port for a one-command override
(for example, --service-port 3000 connects to a development site and its same-origin API).
HEPTAPOD_API_URL remains available as a direct API override.
Run artifacts remain in the target repository.
`;
}

function parseArguments(argv: string[]): ParsedArguments {
  const tokens = [...argv];
  const command = tokens[0]?.startsWith("--") ? undefined : tokens.shift();
  const action = command === "repo" || command === "service" ? tokens.shift() : undefined;
  const options: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = tokens[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[key] = value;
  }
  return { command, action, options };
}

function required(options: Record<string, string>, name: string): string {
  if (!options[name]) throw new Error(`--${name} is required`);
  return options[name];
}

function outputMode(options: Record<string, string>): OutputMode {
  const value = options.output ?? "human";
  if (value !== "human" && value !== "ndjson") throw new Error("--output must be human or ndjson");
  return value;
}

function reporter(mode: OutputMode, jobId: string, reviewId?: string) {
  let sequence = 0;
  return (event: string, fields: Record<string, unknown> = {}) => {
    if (mode === "ndjson") process.stdout.write(`${JSON.stringify({ version: 1, sequence: ++sequence, timestamp: new Date().toISOString(), event, jobId, ...(reviewId ? { reviewId } : {}), ...fields })}\n`);
    else if (typeof fields.message === "string") process.stderr.write(`${fields.message}\n`);
  };
}

function printResult(label: string, result: unknown, mode: OutputMode, report: ReturnType<typeof reporter>): void {
  if (mode === "ndjson") report("command.completed", { result });
  else process.stdout.write(`${label}\n${JSON.stringify(result, null, 2)}\n`);
}

async function publish(repo: string, review: Awaited<ReturnType<typeof ingestReview>>, base: string, report: ReturnType<typeof reporter>) {
  report("stage.started", { stage: "upload", message: "Uploading review to the global Heptapod service" });
  const repository = await ensureRemoteRepository(repo, base);
  const uploaded = await uploadReview(repository, review, base);
  report("stage.completed", { stage: "upload", message: "Review uploaded", url: uploaded.url });
  return uploaded;
}

async function interactive(repo: string, base: string): Promise<void> {
  const selected = await choosePullRequests(repo);
  if (!selected.length) { process.stdout.write("No pull requests selected.\n"); return; }
  let failed = false;
  const progress = createIngestionProgress(selected);
  for (const pullRequest of selected) {
    progress.start(pullRequest.number);
    try {
      const refresh = Boolean(getReview(String(pullRequest.number)));
      const review = await prepareReview(repo, String(pullRequest.number), undefined, undefined, refresh, {
        onProgress: (message) => progress.progress(pullRequest.number, message),
        quiet: true,
      });
      const uploaded = await publish(repo, review, base, (_event, fields = {}) => {
        if (typeof fields.message === "string") progress.progress(pullRequest.number, fields.message);
      });
      progress.complete(pullRequest.number, uploaded.url);
    } catch (error) {
      failed = true;
      progress.fail(pullRequest.number, error instanceof Error ? error.message : String(error));
    }
  }
  progress.finish();
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) { process.stdout.write(usage()); return; }
  const parsed = parseArguments(argv);
  if (!parsed.command) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stdout.write(usage()); return; }
    const repo = repositoryRoot(); process.env.HEPTAPOD_ROOT ??= repo;
    await interactive(repo, apiUrl(parsed.options["api-url"], parsed.options["service-port"])); return;
  }
  if (["help", "--help", "-h"].includes(parsed.command)) { process.stdout.write(usage()); return; }
  const mode = outputMode(parsed.options);
  const jobId = randomUUID();
  const report = reporter(mode, jobId, parsed.options.pr);

  if (parsed.command === "service") {
    const configured = parsed.options.port ? configureService(Number(parsed.options.port)) : null;
    const base = apiUrl(parsed.options["api-url"], parsed.options["service-port"]);
    if (parsed.action === "configure") {
      if (!configured) throw new Error("--port is required");
      printResult("Heptapod service configured. Restart a running service to apply the new port.", configured, mode, report); return;
    }
    if (parsed.action === "run") { await runService(); return; }
    if (parsed.action === "start") { printResult("Heptapod service started.", await startService(base), mode, report); return; }
    if (parsed.action === "status") { printResult("Heptapod service status.", await serviceStatus(base), mode, report); return; }
    if (parsed.action === "stop") { printResult("Heptapod service stopped.", { stopped: stopService() }, mode, report); return; }
    if (parsed.action === "install") { printResult("Heptapod login service installed.", { path: installService() }, mode, report); return; }
    throw new Error(`Unknown service command: ${parsed.action ?? ""}\n\n${usage()}`);
  }

  if (parsed.command === "repo") {
    const base = apiUrl(parsed.options["api-url"], parsed.options["service-port"]);
    if (parsed.action === "list") { printResult("Registered repositories.", await listRemoteRepositories(base), mode, report); return; }
    const repo = repositoryRoot(parsed.options.path);
    process.env.HEPTAPOD_ROOT ??= repo;
    if (parsed.action === "add") { printResult("Repository registered.", await ensureRemoteRepository(repo, base), mode, report); return; }
    if (parsed.action === "sync") {
      const registered = await ensureRemoteRepository(repo, base);
      const databasePath = resolveDatabasePath();
      const reviews = (existsSync(databasePath) ? listReviewsReadOnly(databasePath) : []).filter((review) => review.status === "ready" && review.payload);
      const uploaded = [];
      for (const review of reviews) {
        report("stage.started", { stage: "upload", reviewId: review.id, message: `Uploading existing review ${review.id}` });
        const result = await uploadReview(registered, { id: review.id, payload: review.payload!, metadataDirectory: review.metadataDirectory, agentId: review.agentId }, base);
        uploaded.push(result);
        report("stage.completed", { stage: "upload", reviewId: review.id, message: `Uploaded existing review ${review.id}`, url: result.url });
      }
      printResult("Existing reviews synchronized.", { repository: registered, uploaded }, mode, report); return;
    }
    if (parsed.action === "remove") {
      const registered = await ensureRemoteRepository(repo, base);
      await removeRemoteRepository(parsed.options.id ?? registered.id, base);
      printResult("Repository removed.", { id: parsed.options.id ?? registered.id }, mode, report); return;
    }
    throw new Error(`Unknown repo command: ${parsed.action ?? ""}\n\n${usage()}`);
  }

  if (parsed.options.repo) throw new Error("--repo is not supported; run heptapod from the target repository.");
  if (parsed.options.database) throw new Error("--database is not supported; Heptapod uses the repository-local cache automatically.");
  const repo = repositoryRoot();
  process.env.HEPTAPOD_ROOT ??= repo;
  if (parsed.command === "capture") {
    report("stage.started", { stage: "capture", message: "Capturing the immutable source comparison" });
    const result = captureReview(repo, parsed.options, parsed.options["output-dir"]);
    report("stage.completed", { stage: "capture", message: "Source comparison captured", reviewId: result.id });
    printResult("Captured source diff and scaffold.", result, mode, report);
  } else if (parsed.command === "prepare") {
    const base = apiUrl(parsed.options["api-url"], parsed.options["service-port"]);
    report("stage.started", { stage: "prepare", message: "Preparing review narrative" });
    const review = await prepareReview(repo, required(parsed.options, "pr"), required(parsed.options, "agent"), undefined, Boolean(getReview(required(parsed.options, "pr"))), {
      machineReadable: mode === "ndjson",
      onProgress: (message) => report("stage.progress", { stage: "prepare", message }),
    });
    const uploaded = await publish(repo, review, base, report);
    printResult("Review prepared and uploaded.", { ...review, url: uploaded.url }, mode, report);
  } else if (parsed.command === "validate") {
    report("stage.started", { stage: "validate", message: "Validating the narrative patch stack" });
    const result = validateReview(repo, required(parsed.options, "id"), parsed.options.narrative);
    report("stage.completed", { stage: "validate", message: "Narrative patch stack verified" });
    printResult("Exact reconstruction verified.", result, mode, report);
  } else if (parsed.command === "ingest") {
    const base = apiUrl(parsed.options["api-url"], parsed.options["service-port"]);
    report("stage.started", { stage: "ingest", message: "Starting repository-local ingestion" });
    const review = ingestReview(repo, parsed.options, {
      narrativePath: parsed.options.narrative,
      onProgress: (message) => report("stage.progress", { stage: "ingest", message }),
    });
    const uploaded = await publish(repo, review, base, report);
    if (mode === "ndjson") report("review.completed", { url: uploaded.url, result: { id: review.id, base: review.baseRevision, head: review.headRevision, database: resolveDatabasePath() } });
    else printResult("Exact reconstruction verified and review uploaded.", {
      id: review.id, title: review.title, base: review.baseRevision, head: review.headRevision,
      updatedAt: review.updatedAt, database: resolveDatabasePath(), url: uploaded.url,
    }, mode, report);
  } else {
    throw new Error(`Unknown command: ${parsed.command}\n\n${usage()}`);
  }
}

try { await main(); }
catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const mode = process.argv.includes("ndjson") ? "ndjson" : "human";
  if (mode === "ndjson") process.stdout.write(`${JSON.stringify({ version: 1, event: "review.failed", timestamp: new Date().toISOString(), error: message })}\n`);
  else process.stderr.write(`heptapod: ${message}\n`);
  process.exitCode = error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
}
