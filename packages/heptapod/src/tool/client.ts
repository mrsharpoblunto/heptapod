import type { AgentId } from "@thestraylight/heptapod-core/agents";
import type { RegisteredRepository } from "@thestraylight/heptapod-core/repositories";
import { serviceApiUrl } from "@thestraylight/heptapod-core/service-config";
import type { RenderModel } from "@thestraylight/heptapod-core/types";

export const INGESTION_PROTOCOL_VERSION = 1;
export const REVIEW_PAYLOAD_SCHEMA_VERSION = 1;
export function apiUrl(value?: string, servicePort?: string): string {
  if (value && servicePort) throw new Error("Choose only one of --api-url or --service-port.");
  let selected = value ?? process.env.HEPTAPOD_API_URL ?? serviceApiUrl();
  if (servicePort) {
    const port = Number(servicePort);
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error("--service-port must be an integer from 1024 through 65535.");
    selected = `http://localhost:${port}/api/service`;
  }
  const url = new URL(selected);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Heptapod API URL must use http or https.");
  return url.toString().replace(/\/$/, "");
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", "X-Heptapod-Client": "cli", ...init?.headers } });
  } catch (error) {
    const detail = error instanceof Error
      ? error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
      : String(error);
    throw new Error(`The global Heptapod service request to ${base}${path} failed (${detail}). Install it with \`pnpm add --global @thestraylight/heptapod\`, then run \`heptapod service start\`.`, { cause: error });
  }
  const result = await response.json().catch(() => ({})) as T & { error?: string; ingestionProtocolVersion?: number };
  if (!response.ok) throw new Error(result.error ?? `Heptapod API request failed with HTTP ${response.status}.`);
  return result;
}

export async function checkService(base = apiUrl()): Promise<void> {
  const health = await request<{ ready: boolean; ingestionProtocolVersion: number; reviewPayloadSchemaVersion: number }>(base, "/health");
  if (!health.ready || health.ingestionProtocolVersion !== INGESTION_PROTOCOL_VERSION) {
    throw new Error(`The repository CLI uses ingestion protocol ${INGESTION_PROTOCOL_VERSION}, but the global Heptapod service uses ${health.ingestionProtocolVersion ?? "an unknown version"}. Update the repository CLI or global service.`);
  }
  if (health.reviewPayloadSchemaVersion !== REVIEW_PAYLOAD_SCHEMA_VERSION) throw new Error(`The repository CLI writes review payload schema ${REVIEW_PAYLOAD_SCHEMA_VERSION}, but the global service accepts ${health.reviewPayloadSchemaVersion ?? "an unknown version"}. Update the repository CLI or global service.`);
}

export async function ensureRemoteRepository(root: string, base = apiUrl()): Promise<RegisteredRepository> {
  await checkService(base);
  return request(base, "/repositories", { method: "POST", body: JSON.stringify({ path: root }) });
}

export async function listRemoteRepositories(base = apiUrl()): Promise<RegisteredRepository[]> {
  await checkService(base);
  return request(base, "/repositories");
}

export async function removeRemoteRepository(id: string, base = apiUrl()): Promise<void> {
  await checkService(base);
  await request(base, `/repositories/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface ReviewUpload {
  id: string;
  payload: RenderModel;
  metadataDirectory?: string | null;
  agentId?: AgentId | null;
}

export async function uploadReview(repository: RegisteredRepository, review: ReviewUpload, base = apiUrl()): Promise<{ id: string; url: string }> {
  return request(base, `/repositories/${encodeURIComponent(repository.id)}/reviews`, { method: "PUT", body: JSON.stringify({
    protocolVersion: INGESTION_PROTOCOL_VERSION,
    payloadSchemaVersion: REVIEW_PAYLOAD_SCHEMA_VERSION,
    producerVersion: "0.1.0",
    id: review.id,
    payload: review.payload,
    metadataDirectory: review.metadataDirectory,
    agentId: review.agentId,
  }) });
}
