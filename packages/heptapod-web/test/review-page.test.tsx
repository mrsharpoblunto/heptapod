import assert from "node:assert/strict";
import { test, vi } from "vitest";
import ReviewPage from "../app/repositories/[repositoryId]/reviews/[...id]/page";
import { ReviewViewer } from "../src/web/ReviewViewer";
import { PendingReview } from "../src/web/PendingReview";
const { getReview, getRepository } = vi.hoisted(() => ({ getReview: vi.fn(), getRepository: vi.fn(() => ({ id: "repo", name: "repo", root: "/repo" })) }));
vi.mock("@thestraylight/heptapod-core/database", () => ({ getReview }));
vi.mock("@thestraylight/heptapod-core/repositories", () => ({ getRepository, repositoryDatabasePath: () => "/reviews.sqlite" }));
vi.mock("../src/web/github-metadata", () => ({ githubSourceFromPullRequestUrl: () => undefined, loadGitHubPullRequestMetadata: () => Promise.resolve(null) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));

test("a failed update retains access to its saved review while an import without a payload shows its status card", async () => {
  const review = { id: "42", status: "failed", title: "Saved review", summary: "", error: "Worker stopped", progress: "Building review", updatedAt: "2026-09-12", sourceUrl: null, payload: { source: {}, steps: [] } };
  getReview.mockReturnValue(review);
  const page = await ReviewPage({ params: Promise.resolve({ repositoryId: "repo", id: ["42"] }) });
  const content = page.props.children.props.children.props.children;
  assert.equal(content.type, ReviewViewer);
  assert.equal(content.props.data, review.payload);
  assert.equal(content.props.status, "failed");
  getReview.mockReturnValue({ ...review, payload: null });
  const pending = await ReviewPage({ params: Promise.resolve({ repositoryId: "repo", id: ["42"] }) });
  assert.equal(pending.props.children.props.children.props.children.type, PendingReview);
});
