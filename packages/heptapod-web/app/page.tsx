import { listReviews } from "@thestraylight/heptapod/database";
import { ReviewIndex } from "../src/web/ReviewIndex";
import { connectedRepository } from "../src/web/connected-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function ReviewIndexPage() {
  const reviews = listReviews();
  return <ReviewIndex repository={connectedRepository()} reviews={reviews.map(({ id, title, summary, sourceUrl, baseRevision, headRevision, updatedAt, status, progress, error, payload }) => ({
    id,
    title,
    summary,
    sourceUrl,
    baseRevision,
    headRevision,
    updatedAt,
    status,
    progress,
    error,
    updating: status === "pending" && payload !== null,
    additions: payload?.source.stats.additions ?? null,
    deletions: payload?.source.stats.deletions ?? null,
  }))} />;
}
