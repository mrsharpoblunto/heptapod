import type { StoredReview } from "./database.js";

export function reviewSummary(review: StoredReview) {
  const { id, title, summary, sourceUrl, baseRevision, headRevision, updatedAt, status, progress, error, payload, agentId } = review;
  return {
    id, title, summary, sourceUrl, baseRevision, headRevision, updatedAt, status, progress, error, agentId, hasPayload: payload !== null,
    updating: (status === "pending" || status === "preparing") && payload !== null,
    additions: payload?.source.stats.additions ?? null,
    deletions: payload?.source.stats.deletions ?? null,
  };
}
