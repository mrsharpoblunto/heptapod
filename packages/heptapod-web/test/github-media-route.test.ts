import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { GET } from "../app/api/reviews/[id]/github-media/[assetId]/route";
const { review, resolveMedia } = vi.hoisted(() => ({ review: vi.fn(), resolveMedia: vi.fn() }));
vi.mock("@thestraylight/heptapod-core/database", () => ({ getReview: review }));
vi.mock("../src/web/github-metadata", () => ({ resolveGitHubMediaUrl: resolveMedia }));
const assetId = "0e4c2d6b-beff-4dea-9b83-afd15b0ba4c5";
const github = { number: 62, repositoryUrl: "https://github.com/example/repo", pullRequestUrl: "https://github.com/example/repo/pull/62" };
const context = { params: Promise.resolve({ id: "62", assetId }) };
test("proxies authenticated manual-check screenshots and preserves video range responses", async () => {
  const fetchMedia = vi.fn(); vi.stubGlobal("fetch", fetchMedia);
  try {
    for (const kind of ["image", "video"]) {
      review.mockReturnValue({ payload: { source: { github }, steps: [{ checks: { automated: [], manual: [{ evidence: [{ kind, url: `https://github.com/user-attachments/assets/${assetId}` }] }] } }] } });
      resolveMedia.mockResolvedValue(`https://private-user-images.githubusercontent.com/${assetId}?jwt=signed`);
      const status = kind === "video" ? 206 : 200;
      fetchMedia.mockResolvedValue(new Response("media bytes", { status, headers: { "Content-Type": kind === "video" ? "video/mp4" : "image/png", "Accept-Ranges": "bytes" } }));
      const response = await GET(new Request("http://localhost/media", { headers: { Range: "bytes=0-10" } }), context);
      assert.equal(response.status, status);
      assert.equal(await response.text(), "media bytes");
      assert.deepEqual(resolveMedia.mock.lastCall, [github, assetId, kind]);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      assert.deepEqual(fetchMedia.mock.lastCall?.[1].headers, { Range: "bytes=0-10" });
    }
    review.mockReturnValue({ payload: { source: { github }, steps: [] } });
    fetchMedia.mockClear();
    assert.equal((await GET(new Request("http://localhost/media"), context)).status, 404);
    assert.equal(fetchMedia.mock.calls.length, 0);
  } finally { vi.unstubAllGlobals(); }
});
