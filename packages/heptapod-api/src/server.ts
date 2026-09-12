import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { cancelProcess } from "./cancel-process.js";
import type { AgentId } from "@thestraylight/heptapod-core/agents";
import { parsePullRequestNumber } from "@thestraylight/heptapod-core/review-source";
import { beginReviewPreparation, beginReviewUpdate, deleteReview, failReviewIngestion, getReview, listReviews, saveReviewDraft } from "@thestraylight/heptapod-core/database";
import { removeReviewRun, resolveReviewRunDirectory, validateReviewId } from "@thestraylight/heptapod-core/cache";
import { loadDraftState } from "@thestraylight/heptapod-core/review-draft-service";
import type { ReviewComment } from "@thestraylight/heptapod-core/types";
import { reviewSummary } from "@thestraylight/heptapod-core/review-summary";

async function jsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
interface Job { status: "pending" | "ready" | "failed" | "cancelled"; result?: unknown; error?: string; updatedAt: number }

export function createApiServer({ root, webOrigin }: { root: string; webOrigin: string }) {
  process.env.HEPTAPOD_ROOT = root;
  interface RunningJob { child: ChildProcess; reviewId?: string; sequence: number; exited: Promise<void>; cancellation?: Promise<void> }
  const workers = new Map<string, RunningJob>();
  const deleting = new Set<string>();
  const deletions = new Map<string, number>();
  let sequence = 0;
  const jobs = new Map<string, Job>();
  const allowedOrigins = new Set([webOrigin]);
  const origin = new URL(webOrigin);
  if (["localhost", "127.0.0.1", "0.0.0.0", "::"].includes(origin.hostname)) {
    for (const hostname of ["localhost", "127.0.0.1"]) { const alias = new URL(origin); alias.hostname = hostname; allowedOrigins.add(alias.origin); }
  }
  async function cancel(jobId: string, job: RunningJob) {
    if (!job.cancellation) {
      jobs.set(jobId, { status: "cancelled", updatedAt: Date.now() });
      job.cancellation = cancelProcess(job.child, job.exited).finally(() => workers.delete(jobId));
    }
    await job.cancellation;
  }
  function launch(jobId: string, data: Record<string, unknown>, reviewId?: string) {
    const child = fork(new URL("./worker.js", import.meta.url), [], { detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let onExit!: () => void;
    const job: RunningJob = { child, reviewId: reviewId ?? data.id as string | undefined, sequence: ++sequence, exited: new Promise<void>((resolve) => { onExit = resolve; }) };
    workers.set(jobId, job);
    jobs.set(jobId, { status: "pending", updatedAt: Date.now() });
    const fail = (error: string) => {
      if (jobs.get(jobId)?.status !== "pending") return;
      jobs.set(jobId, { status: "failed", error, updatedAt: Date.now() });
      if (job.reviewId && (data.operation === "prepare" || data.operation === "ingest")) failReviewIngestion(job.reviewId, error);
    };
    child.on("message", (message: { type: string; id?: string } & Omit<Job, "updatedAt">) => {
      if (jobs.get(jobId)?.status === "cancelled") return;
      if (message.type === "review" && message.id) {
        job.reviewId = message.id;
        if (deleting.has(message.id) || (deletions.get(message.id) ?? 0) > job.sequence) {
          void cancel(jobId, job).catch((error) => fail(String(error)));
        } else child.send({ type: "continue" });
      } else if (message.type === "result") {
        jobs.set(jobId, { status: message.status, result: message.result, error: message.error, updatedAt: Date.now() });
      }
    });
    child.once("error", (error) => { fail(error.message); if (!child.pid) { onExit(); workers.delete(jobId); } });
    child.once("exit", onExit);
    // Exit may precede delivery of buffered IPC data. Close waits for its channel.
    child.once("close", (code) => {
      if (!job.cancellation) workers.delete(jobId);
      if (jobs.get(jobId)?.status === "pending") fail(`Review worker stopped (exit ${code}).`);
    });
    child.send({ root, ...data });
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    const url = new URL(request.url ?? "/", "http://localhost");
    // The browser uses a same-origin Next rewrite; reject cross-site mutations.
    if (request.method !== "GET" && !allowedOrigins.has(request.headers.origin ?? "")) { send(403, { error: "Invalid request origin." }); return; }
    for (const [id, job] of jobs) if (job.status !== "pending" && job.updatedAt < Date.now() - 60 * 60_000) jobs.delete(id);
    try {
      if (request.method === "GET" && url.pathname === "/health") { send(200, { ready: true }); return; }
      if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
        const job = jobs.get(decodeURIComponent(url.pathname.slice(6)));
        send(job ? 200 : 404, job ?? { error: "Job not found. The API server may have restarted." }); return;
      }
      const refreshPath = url.pathname.match(/^\/reviews\/(\d+)\/refresh$/);
      if (request.method === "POST" && refreshPath) {
        const id = refreshPath[1];
        const review = getReview(id);
        if (!review?.payload || !review.sourceUrl) { send(404, { error: "An imported pull request is required." }); return; }
        if (deleting.has(id) || workers.has(`prepare:${id}`) || workers.has(`publish:${id}`) || !beginReviewUpdate(id)) {
          send(409, { error: "This review already has active work." }); return;
        }
        try {
          const jobId = `prepare:${id}`;
          launch(jobId, { operation: "prepare", id, agent: review.agentId, refresh: true });
          send(202, { id, jobId, status: "preparing" }); return;
        } catch (error) { failReviewIngestion(id, error instanceof Error ? error.message : String(error)); throw error; }
      }
      const draftPath = url.pathname.match(/^\/reviews\/([^/]+)\/draft(\/publish)?$/);
      if (draftPath) {
        const id = decodeURIComponent(draftPath[1]);
        if (request.method === "GET" && !draftPath[2]) { send(200, await loadDraftState(id)); return; }
        const body = await jsonBody(request);
        if (!Number.isSafeInteger(body.version)) throw new Error("Missing draft version.");
        if (request.method === "POST" && draftPath[2]) {
          const jobId = `publish:${id}`;
          if (deleting.has(id)) { send(409, { error: "This review is being deleted." }); return; }
          if (!workers.has(jobId)) launch(jobId, { operation: "publish", id, version: body.version });
          send(202, { jobId }); return;
        }
        if (request.method === "PUT" && !draftPath[2]) {
          if (body.summaryIsCombined !== undefined && typeof body.summaryIsCombined !== "boolean") throw new Error("Invalid review summary mode.");
          saveReviewDraft(id, body.version as number, body.summary as string, body.comments as ReviewComment[], undefined, body.summaryIsCombined as boolean | undefined);
          send(200, await loadDraftState(id)); return;
        }
      }
      if (url.pathname === "/reviews") {
        const id = url.searchParams.get("review");
        if (request.method === "GET") {
          const reviews = id ? [getReview(id)].filter((review) => review !== null) : listReviews();
          if (id && !reviews.length) { send(404, { error: "Review not found." }); return; }
          const statuses = reviews.map(({ id, status, progress, error, updatedAt }) => ({ id, status, progress, error, updatedAt }));
          send(200, id ? statuses[0] : reviews.map(reviewSummary)); return;
        }
        if (request.method === "DELETE" && id) {
          validateReviewId(id);
          if (deleting.has(id)) { send(409, { error: "This review is already being deleted." }); return; }
          deleting.add(id);
          deletions.set(id, ++sequence);
          try {
            const active = [...workers].filter(([, job]) => job.reviewId === id);
            await Promise.all(active.map(([jobId, job]) => cancel(jobId, job)));
            const deletedReview = deleteReview(id);
            const deletedRun = removeReviewRun(id);
            send(deletedReview || deletedRun || active.length ? 200 : 404, { id, deletedReview, deletedRun }); return;
          } finally { deleting.delete(id); }
        }
      }
      if (request.method === "POST" && url.pathname === "/reviews/prepare") {
        const { number, agent } = await jsonBody(request);
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || !["codex", "claude"].includes(String(agent))) {
          send(400, { error: "Choose a valid pull request and supported agent." }); return;
        }
        const id = String(number);
        if (deleting.has(id)) { send(409, { error: "This review is being deleted." }); return; }
        const directory = resolveReviewRunDirectory(id);
        if (!beginReviewPreparation(id, { title: `Pull request #${id}`, metadataDirectory: directory, agentId: agent as AgentId }, undefined, true)) {
          send(409, { error: "This review is already imported or being prepared." }); return;
        }
        try {
          mkdirSync(directory, { recursive: true });
          const jobId = `prepare:${id}`;
          launch(jobId, { operation: "prepare", id, agent });
          send(202, { id, jobId, status: "preparing" }); return;
        } catch (error) { failReviewIngestion(id, error instanceof Error ? error.message : String(error)); throw error; }
      }
      if (request.method === "POST" && ["/reviews/capture", "/reviews/ingest"].includes(url.pathname)) {
        const { pr, rev } = await jsonBody(request);
        if ((typeof pr !== "string" && typeof rev !== "string") || Boolean(pr) === Boolean(rev)) throw new Error("Choose exactly one PR number or revision range.");
        const reviewId = typeof pr === "string" ? String(parsePullRequestNumber(pr)) : undefined;
        if (reviewId && deleting.has(reviewId)) { send(409, { error: "This review is being deleted." }); return; }
        const jobId = randomUUID();
        launch(jobId, { operation: url.pathname.endsWith("capture") ? "capture" : "ingest", selection: { pr, rev } }, reviewId);
        send(202, { jobId }); return;
      }
      send(404, { error: "Unknown API endpoint." });
    } catch (error) { send(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  return { server, async stop() {
    await Promise.all([...workers].map(async ([jobId, job]) => {
      if (jobs.get(jobId)?.status !== "pending") { await job.exited; return; }
      await cancel(jobId, job);
      const review = job.reviewId ? getReview(job.reviewId) : null;
      if (review?.status === "pending" || review?.status === "preparing") failReviewIngestion(review.id, "Review work was cancelled because the API server stopped.");
    }));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
