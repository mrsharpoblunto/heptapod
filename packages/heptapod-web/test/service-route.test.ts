import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { DELETE, GET, POST, PUT } from "../app/api/service/[...path]/route";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function context(...path: string[]) { return { params: Promise.resolve({ path }) }; }
function mutation(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", "X-Heptapod-Client": "cli" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("the website serves repository registration and versioned review ingestion on its own port", async () => {
  const state = mkdtempSync(join(tmpdir(), "heptapod-web-state-")); directories.push(state); vi.stubEnv("HEPTAPOD_STATE_DIR", state);
  const root = mkdtempSync(join(tmpdir(), "heptapod-web-repo-")); directories.push(root);
  execFileSync("git", ["init", "-q", root]);

  const health = await GET(new Request("http://localhost:3000/api/service/health"), context("health"));
  assert.deepEqual(await health.json(), { ready: true, ingestionProtocolVersion: 1, reviewPayloadSchemaVersion: 1 });

  const addedResponse = await POST(mutation("http://localhost:3000/api/service/repositories", "POST", { path: root }), context("repositories"));
  assert.equal(addedResponse.status, 201);
  const repository = await addedResponse.json() as { id: string };

  const payload = {
    title: "Review 42",
    summary: "A stored review",
    source: { base: "a".repeat(40), head: "b".repeat(40), diff: "", stats: { additions: 2, deletions: 1 } },
    steps: [],
  };
  const uploadedResponse = await PUT(mutation(`http://localhost:3000/api/service/repositories/${repository.id}/reviews`, "PUT", {
    protocolVersion: 1, payloadSchemaVersion: 1, producerVersion: "test", id: "42", payload,
  }), context("repositories", repository.id, "reviews"));
  assert.equal(uploadedResponse.status, 200);
  assert.deepEqual(await uploadedResponse.json(), {
    id: "42", url: `http://localhost:3000/repositories/${repository.id}/reviews/42`,
  });

  const listedResponse = await GET(new Request(`http://localhost:3000/api/service/repositories/${repository.id}/reviews`), context("repositories", repository.id, "reviews"));
  const listed = await listedResponse.json() as Array<{ id: string; title: string }>;
  assert.deepEqual(listed.map(({ id, title }) => ({ id, title })), [{ id: "42", title: "Review 42" }]);

  const removed = await DELETE(mutation(`http://localhost:3000/api/service/repositories/${repository.id}`, "DELETE"), context("repositories", repository.id));
  assert.equal(removed.status, 200);
});

test("same-origin API mutations reject requests without a browser origin or CLI marker", async () => {
  const response = await POST(new Request("http://localhost:3000/api/service/repositories", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "." }),
  }), context("repositories"));
  assert.equal(response.status, 403);
});
