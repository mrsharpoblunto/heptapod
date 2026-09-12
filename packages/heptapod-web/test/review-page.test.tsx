import assert from "node:assert/strict";
import { test, vi } from "vitest";
import ReviewPage from "../app/reviews/[...id]/page";
import { ReviewViewer } from "../src/web/ReviewViewer";
import { PendingReview } from "../src/web/PendingReview";
const { getReview } = vi.hoisted(() => ({ getReview: vi.fn() }));
vi.mock("@thestraylight/heptapod-core/database", () => ({ getReview }));
vi.mock("../src/web/github-metadata", () => ({ githubSourceFromPullRequestUrl: () => undefined, loadGitHubPullRequestMetadata: () => Promise.resolve(null) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));

test("a failed update retains access to its saved review while an import without a payload shows its status card", async () => {
  const review = { id: "42", status: "failed", title: "Saved review", summary: "", error: "Worker stopped", progress: "Building review", updatedAt: "2026-09-12", sourceUrl: null, payload: { source: {}, steps: [] } };
  getReview.mockReturnValue(review);
  const page = await ReviewPage({ params: Promise.resolve({ id: ["42"] }) });
  assert.equal(page.props.children.type, ReviewViewer);
  assert.equal(page.props.children.props.data, review.payload);
  assert.equal(page.props.children.props.status, "failed");
  getReview.mockReturnValue({ ...review, payload: null });
  const pending = await ReviewPage({ params: Promise.resolve({ id: ["42"] }) });
  assert.equal(pending.props.children.type, PendingReview);
});
