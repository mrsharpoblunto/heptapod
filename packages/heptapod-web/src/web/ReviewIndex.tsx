"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { reviewPath } from "./ReviewHeader";
import { ReviewCard, type ReviewSummary } from "./ReviewCard";
import { useDeleteReview } from "./useDeleteReview";
import { ReviewListContext } from "./ReviewListContext";
import Link from "next/link";
import { useRepositoryId } from "./RepositoryContext";
export type { ReviewSummary } from "./ReviewCard";

export function ReviewIndex({ reviews: initialReviews, setup, openPullRequests, repositoryName }: { reviews: ReviewSummary[]; setup?: ReactNode; openPullRequests?: ReactNode; repositoryName?: string }) {
  const router = useRouter();
  const repositoryId = useRepositoryId();
  const [snapshot, setSnapshot] = useState<{ initial: ReviewSummary[]; reviews: ReviewSummary[] } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);
  const reviews = snapshot?.initial === initialReviews ? snapshot.reviews : initialReviews;
  const context = useMemo(() => ({ reviews, refresh }), [reviews, refresh]);
  const { deleting, remove, confirmation } = useDeleteReview(false, refresh);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    let current = initialReviews;
    const poll = async () => {
      try {
        const response = await fetch(repositoryId ? `/api/repositories/${encodeURIComponent(repositoryId)}/reviews` : "/api/reviews", { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const next = await response.json() as ReviewSummary[];
          if (!Array.isArray(next) || next.some((review) => typeof review.title !== "string" || typeof review.summary !== "string" || typeof review.hasPayload !== "boolean")) return;
          if (!stopped) {
            current = next;
            setSnapshot((previous) => previous?.initial === initialReviews && JSON.stringify(previous.reviews) === JSON.stringify(next) ? previous : { initial: initialReviews, reviews: next });
          }
        }
      } catch { /* Keep the current list when a polling request fails. */ }
      finally { if (!stopped) timer = setTimeout(poll, current.some((review) => review.status === "pending" || review.status === "preparing") ? 1_000 : 5_000); }
    };
    timer = setTimeout(poll, refreshVersion ? 0 : 1_000);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [initialReviews, refreshVersion, repositoryId]);

  return <ReviewListContext.Provider value={context}><main className="review-index-scene">
    <div className="review-index">
      <header className="review-index-header">
        <div><h1 className="review-index-title">HEPTAPOD</h1></div>
        {setup}
      </header>
      {repositoryId && <nav className="repository-breadcrumb" aria-label="Repository">
        <h2 className="review-section-title"><Link href="/">Repositories</Link><span aria-hidden="true">/</span><span className="repository-breadcrumb-current">{repositoryName}</span></h2>
      </nav>}
      {reviews.length === 0
        ? <div className="empty-state">No reviews have been ingested yet.</div>
        : <div className="review-list">
          {reviews.map((review) => <ReviewCard
            key={review.id}
            review={review}
            deleting={deleting === review.id}
            onDelete={(item) => void remove(item)}
            onOpen={(item) => router.push(reviewPath(item.id, repositoryId))}
          />)}
        </div>}
      {openPullRequests}
    </div>
  </main>{confirmation}</ReviewListContext.Provider>;
}
