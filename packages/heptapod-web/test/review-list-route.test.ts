import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { GET } from "../app/api/reviews/route";
const { listReviews } = vi.hoisted(() => ({ listReviews: vi.fn() }));
vi.mock("@thestraylight/heptapod-core/database", () => ({ listReviews }));

test("JSON polling retains card content for new imports and updates without sending review payloads", async () => {
  const review = { id: "42", title: "Saved review", summary: "Review description", sourceUrl: "https://github.com/example/repo/pull/42", baseRevision: "base", headRevision: "head", updatedAt: "2026-09-12", status: "pending", progress: "Running tests", error: null, agentId: "codex", payload: { source: { stats: { additions: 12, deletions: 3 } } } };
  listReviews.mockReturnValue([review, { ...review, id: "43", status: "preparing", payload: null }]);
  const response = GET();
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const [updating, preparing] = await response.json();
  assert.equal(updating.title, review.title);
  assert.equal(updating.summary, review.summary);
  assert.equal(updating.hasPayload, true);
  assert.equal(updating.updating, true);
  assert.equal(updating.additions, 12);
  assert.equal(updating.deletions, 3);
  assert.equal("payload" in updating, false);
  assert.equal(preparing.hasPayload, false);
  assert.equal(preparing.updating, false);
  assert.equal(preparing.title, review.title);
});
