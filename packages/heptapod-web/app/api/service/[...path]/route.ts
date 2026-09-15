import { join } from "node:path";
import { NextResponse } from "next/server";
import {
  beginReviewPreparation,
  deleteReview,
  getManualTestState,
  getReview,
  listReviews,
  saveReviewDraft,
  setManualTestResult,
  upsertReview,
} from "@thestraylight/heptapod-core/database";
import { validateReviewId } from "@thestraylight/heptapod-core/cache";
import {
  getRepository,
  listRepositories,
  registerRepository,
  removeRepository,
  repositoryDatabasePath,
} from "@thestraylight/heptapod-core/repositories";
import { loadDraftState, publishReviewDraft } from "@thestraylight/heptapod-core/review-draft-service";
import { reviewSummary } from "@thestraylight/heptapod-core/review-summary";
import type { RenderModel, ReviewComment } from "@thestraylight/heptapod-core/types";
import { pickRepositoryDirectory } from "../../../../src/web/repository-picker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INGESTION_PROTOCOL_VERSION = 1;
const REVIEW_PAYLOAD_SCHEMA_VERSION = 1;
const MAX_BODY_SIZE = 64 * 1024 * 1024;

interface RouteContext { params: Promise<{ path: string[] }> }
interface RepositoryContext { id: string; root: string; databasePath: string }

function response(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_SIZE) throw new Error("Request body is too large.");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_SIZE) throw new Error("Request body is too large.");
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

function mutationAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("x-heptapod-client") === "cli";
  try { return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host); }
  catch { return false; }
}

function repositoryContext(parts: string[]): RepositoryContext | null {
  if (parts[0] !== "repositories" || !parts[1]) return null;
  const repository = getRepository(parts[1]);
  return repository ? { id: repository.id, root: repository.root, databasePath: repositoryDatabasePath(repository.id) } : null;
}

function reviewId(parts: string[], trailingSegments: number): string {
  const id = parts.slice(3, parts.length - trailingSegments).join("/");
  validateReviewId(id);
  return id;
}

async function handle(request: Request, route: RouteContext) {
  const { path: parts } = await route.params;
  if (request.method !== "GET" && !mutationAllowed(request)) return response({ error: "Invalid request origin." }, 403);

  try {
    if (request.method === "GET" && parts.length === 1 && parts[0] === "health") {
      return response({ ready: true, ingestionProtocolVersion: INGESTION_PROTOCOL_VERSION, reviewPayloadSchemaVersion: REVIEW_PAYLOAD_SCHEMA_VERSION });
    }

    if (parts.length === 1 && parts[0] === "repositories") {
      if (request.method === "GET") return response(listRepositories());
      if (request.method === "POST") {
        const body = await jsonBody(request);
        if (typeof body.path !== "string" || !body.path.trim()) throw new Error("A repository path is required.");
        return response(registerRepository(body.path), 201);
      }
    }

    if (parts.length === 2 && parts[0] === "repositories" && parts[1] === "pick" && request.method === "POST") {
      const path = await pickRepositoryDirectory();
      return path ? response(registerRepository(path), 201) : response({ cancelled: true });
    }

    if (parts.length === 2 && parts[0] === "repositories" && request.method === "DELETE") {
      return removeRepository(parts[1]) ? response({ id: parts[1] }) : response({ error: "Repository not found." }, 404);
    }

    const repository = repositoryContext(parts);
    if (!repository) return response({ error: "Repository not found." }, 404);

    if (parts[2] !== "reviews") return response({ error: "API route not found." }, 404);

    if (parts.length === 3) {
      const url = new URL(request.url);
      const id = url.searchParams.get("review");
      if (request.method === "GET") {
        if (id) {
          const stored = getReview(id, repository.databasePath);
          return stored ? response(reviewSummary(stored)) : response({ error: "Review not found." }, 404);
        }
        return response(listReviews(repository.databasePath).map(reviewSummary));
      }
      if (request.method === "DELETE" && id) {
        validateReviewId(id);
        return deleteReview(id, repository.databasePath)
          ? response({ id, deletedReview: true, deletedRun: false })
          : response({ error: "Review not found." }, 404);
      }
      if (request.method === "PUT") {
        const body = await jsonBody(request);
        if (body.protocolVersion !== INGESTION_PROTOCOL_VERSION) {
          return response({ error: "Update the repository Heptapod CLI or global Heptapod service.", ingestionProtocolVersion: INGESTION_PROTOCOL_VERSION }, 426);
        }
        if (body.payloadSchemaVersion !== REVIEW_PAYLOAD_SCHEMA_VERSION) {
          return response({ error: "The global Heptapod service does not support this review payload version.", reviewPayloadSchemaVersion: REVIEW_PAYLOAD_SCHEMA_VERSION }, 426);
        }
        if (typeof body.id !== "string" || !body.payload || typeof body.payload !== "object") throw new Error("Invalid review report.");
        validateReviewId(body.id);
        const payload = body.payload as RenderModel;
        if (typeof payload.title !== "string" || !payload.source || !Array.isArray(payload.steps)) throw new Error("Invalid review payload.");
        beginReviewPreparation(body.id, {
          title: payload.title,
          sourceUrl: payload.source.github?.pullRequestUrl,
          baseRevision: payload.source.base,
          headRevision: payload.source.head,
          metadataDirectory: typeof body.metadataDirectory === "string"
            ? body.metadataDirectory
            : join(repository.root, "node_modules/.cache/heptapod/runs", body.id),
          agentId: body.agentId === "codex" || body.agentId === "claude" ? body.agentId : undefined,
        }, repository.databasePath);
        const stored = upsertReview(body.id, payload, repository.databasePath);
        const encodedReview = stored.id.split("/").map(encodeURIComponent).join("/");
        return response({ id: stored.id, url: `${new URL(request.url).origin}/repositories/${repository.id}/reviews/${encodedReview}` });
      }
    }

    if (parts.at(-1) === "manual-tests") {
      const id = reviewId(parts, 1);
      if (request.method === "GET") return response(getManualTestState(id, repository.databasePath));
      if (request.method === "PUT") {
        const body = await jsonBody(request);
        if (typeof body.head !== "string" || typeof body.checkId !== "string" || typeof body.tested !== "boolean") throw new Error("Invalid manual test result.");
        return response(setManualTestResult(id, body.head, body.checkId, body.tested, repository.databasePath));
      }
    }

    const publishing = parts.at(-2) === "draft" && parts.at(-1) === "publish";
    const drafting = parts.at(-1) === "draft";
    if (publishing || drafting) {
      const id = reviewId(parts, publishing ? 2 : 1);
      const storage = { root: repository.root, databasePath: repository.databasePath };
      if (request.method === "GET" && drafting) return response(await loadDraftState(id, storage));
      const body = await jsonBody(request);
      if (!Number.isSafeInteger(body.version)) throw new Error("Missing draft version.");
      if (request.method === "POST" && publishing) return response(await publishReviewDraft(id, body.version as number, undefined, storage));
      if (request.method === "PUT" && drafting) {
        if (typeof body.summary !== "string" || !Array.isArray(body.comments)) throw new Error("Invalid review draft.");
        if (body.summaryIsCombined !== undefined && typeof body.summaryIsCombined !== "boolean") throw new Error("Invalid review summary mode.");
        saveReviewDraft(id, body.version as number, body.summary, body.comments as ReviewComment[], repository.databasePath, body.summaryIsCombined as boolean | undefined);
        return response(await loadDraftState(id, storage));
      }
    }

    return response({ error: "API route not found." }, 404);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

export function GET(request: Request, route: RouteContext) { return handle(request, route); }
export function POST(request: Request, route: RouteContext) { return handle(request, route); }
export function PUT(request: Request, route: RouteContext) { return handle(request, route); }
export function DELETE(request: Request, route: RouteContext) { return handle(request, route); }
