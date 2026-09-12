import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { GET } from "../app/api/pull-requests/route";
const { load, repository, reviews } = vi.hoisted(() => ({ load: vi.fn(), repository: vi.fn(), reviews: vi.fn() }));
vi.mock("../src/web/setup", () => ({ loadPullRequestPage: load }));
vi.mock("../src/web/connected-repository", () => ({ connectedRepository: repository }));
vi.mock("@thestraylight/heptapod-core/database", () => ({ listReviews: reviews }));

test("proxies a cursor page directly, preserves paging through imported results, and filters preparing reviews", async () => {
  repository.mockResolvedValue({ name: "example/repo", githubUrl: "https://github.com/example/repo" });
  reviews.mockReturnValue([{ id: "42", sourceUrl: "https://github.com/example/repo/pull/42" }]);
  load.mockResolvedValue({ pullRequests: [{ number: 42, url: "https://github.com/example/repo/pull/42" }], hasNextPage: true, endCursor: "next" });
  const response = await GET(new Request("http://localhost/api/pull-requests?cursor=first&includeClosed=true"));
  assert.equal(response.status, 200);
  assert.deepEqual(load.mock.lastCall, ["example/repo", true, "first"]);
  assert.deepEqual(await response.json(), { pullRequests: [], hasNextPage: true, endCursor: "next" });
});
test("propagates page request errors for retry without creating a background job", async () => {
  repository.mockResolvedValue({ name: "example/repo", githubUrl: "https://github.com/example/repo" });
  load.mockRejectedValue(new Error("GitHub temporarily unavailable"));
  const response = await GET(new Request("http://localhost/api/pull-requests"));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "GitHub temporarily unavailable" });
});
