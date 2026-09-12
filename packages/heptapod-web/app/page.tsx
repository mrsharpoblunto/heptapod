import { listReviews } from "@thestraylight/heptapod/database";
import { ReviewIndex } from "../src/web/ReviewIndex";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function ReviewIndexPage() {
  const reviews = listReviews();
  return <ReviewIndex reviews={reviews.map(({ id, title, summary, sourceUrl, baseRevision, headRevision, updatedAt, status, progress, error, payload }) => ({
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
    additions: payload?.source.stats.additions ?? null,
    deletions: payload?.source.stats.deletions ?? null,
  }))} />;
}
