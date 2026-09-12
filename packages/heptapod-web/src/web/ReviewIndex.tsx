"use client";

import { LoaderCircle, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ReviewHeader, reviewPath, type ReviewHeaderData } from "./ReviewHeader";
import type { ConnectedRepository } from "./connected-repository";

interface ReviewSummary extends ReviewHeaderData {
  status: "pending" | "ready" | "failed";
  progress: string | null;
  error: string | null;
  updating?: boolean;
}

function ReviewCard({
  review,
  deleting,
  onDelete,
  onOpen,
}: {
  review: ReviewSummary;
  deleting: boolean;
  onDelete: (review: ReviewSummary) => void;
  onOpen: (review: ReviewSummary) => void;
}): ReactNode {
  return <article
    className="review-list-item"
    onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("a, button")) return;
      onOpen(review);
    }}
  >
    <div className="review-list-content">
      <ReviewHeader review={review} compact updating={review.updating}>
        {review.status !== "ready" && <div className={`review-state review-state-${review.status}`}>
          {review.status === "pending"
            ? <LoaderCircle aria-hidden="true" className="progress-spinner" size={15} />
            : <span className="failure-dot" />}
          <span>{review.status === "pending" ? review.progress ?? "Preparing ingestion" : review.error ?? "Ingestion failed"}</span>
        </div>}
      </ReviewHeader>
    </div>
    <button
      aria-label={`Delete review ${review.id}`}
      className="review-delete"
      disabled={deleting}
      onClick={() => onDelete(review)}
      title="Delete review and cached narrative"
    >
      <Trash2 aria-hidden="true" size={16} />
    </button>
  </article>;
}

export function ReviewIndex({ reviews, repository }: { reviews: ReviewSummary[]; repository: ConnectedRepository }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const interval = reviews.some((review) => review.status === "pending") ? 1_000 : 5_000;
    const timer = window.setInterval(() => router.refresh(), interval);
    return () => window.clearInterval(timer);
  }, [reviews, router]);

  const remove = async (review: ReviewSummary) => {
    if (!window.confirm(`Delete review ${review.id} and its cached narrative files?`)) return;
    setDeleting(review.id);
    setError(null);
    try {
      const response = await fetch(`/api/reviews?review=${encodeURIComponent(review.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? `Delete failed with HTTP ${response.status}`);
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleting(null);
    }
  };

  return <main className="review-index-scene">
    <div className="review-index">
      <h1 className="review-index-title">HEPTAPOD</h1>
      <section className="ingestion-help" aria-label="Ingestion instructions">
        <p>Connected repository: {repository.githubUrl
          ? <a href={repository.githubUrl} target="_blank" rel="noreferrer">{repository.name}</a>
          : <strong>{repository.name}</strong>}</p>
        <p>Use the installed agent skill to author the narrative between capture and ingestion.</p>
        <div className="ingestion-commands">
          <div><span>Pull request</span><code>pnpm exec heptapod capture --pr &lt;number&gt;</code><code>pnpm exec heptapod ingest --pr &lt;number&gt;</code></div>
          <div><span>Revision range</span><code>pnpm exec heptapod capture --rev &lt;base&gt;...&lt;target&gt;</code><code>pnpm exec heptapod ingest --rev &lt;base&gt;...&lt;target&gt;</code></div>
        </div>
      </section>
      {error && <p className="review-index-error">{error}</p>}
      {reviews.length === 0
        ? <div className="empty-state">No reviews have been ingested yet.</div>
        : <div className="review-list">
          {reviews.map((review) => <ReviewCard
            key={review.id}
            review={review}
            deleting={deleting === review.id}
            onDelete={(item) => void remove(item)}
            onOpen={(item) => router.push(reviewPath(item.id))}
          />)}
        </div>}
    </div>
  </main>;
}
