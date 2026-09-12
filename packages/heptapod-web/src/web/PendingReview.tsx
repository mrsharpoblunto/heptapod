"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ReviewCard, type ReviewSummary } from "./ReviewCard";
import { useDeleteReview } from "./useDeleteReview";

export function PendingReview({ review }: { review: ReviewSummary }) {
  const { id, status, progress } = review;
  const { deleting, remove, confirmation } = useDeleteReview(true);
  const router = useRouter();
  useEffect(() => {
    if (status !== "pending" && status !== "preparing") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/service/reviews?review=${encodeURIComponent(id)}`, { cache: "no-store" });
        if (response.status === 404 && !stopped) { router.replace("/"); return; }
        if (response.ok) {
          const review = await response.json();
          if (!stopped && (review.status !== status || review.progress !== progress)) router.refresh();
        }
      } catch { /* Retry when the sidecar is available again. */ }
      finally { if (!stopped) timer = setTimeout(poll, 1_000); }
    };
    timer = setTimeout(poll, 1_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, router, status, progress]);

  return <><main className="review-index-scene"><div className="review-index">
    <h1 className="review-index-title">HEPTAPOD</h1>
    <Link className="review-list-back" href="/">All reviews</Link>
    <div className="review-list"><ReviewCard review={review} deleting={deleting === id} onDelete={(item) => void remove(item)} /></div>
  </div></main>{confirmation}</>;
}
