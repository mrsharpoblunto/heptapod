"use client";

import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentId } from "@thestraylight/heptapod-core/agents";
import { RefreshReviewButton } from "./RefreshReviewButton";
import { ReviewProgress } from "./ReviewProgress";
import { ReviewHeader, type ReviewHeaderData } from "./ReviewHeader";

export interface ReviewSummary extends ReviewHeaderData {
  status: "preparing" | "pending" | "ready" | "failed";
  progress: string | null;
  error: string | null;
  updating?: boolean;
  agentId?: AgentId | null;
  hasPayload?: boolean;
}

export function canOpenReview(review: ReviewSummary): boolean {
  return (review.status !== "preparing" && review.status !== "pending") || review.updating === true;
}

export function ReviewCard({
  review,
  deleting,
  onDelete,
  onOpen,
}: {
  review: ReviewSummary;
  deleting: boolean;
  onDelete: (review: ReviewSummary) => void;
  onOpen?: (review: ReviewSummary) => void;
}): ReactNode {
  const refreshable = Boolean((review.hasPayload || review.status === "ready" || review.updating) && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(review.sourceUrl ?? ""));
  const clickable = Boolean(onOpen && canOpenReview(review));
  return <article
    className={`review-list-item review-card${clickable ? " review-list-item-clickable" : ""}`}
    onClick={clickable ? (event) => {
      if (event.target instanceof Element && event.target.closest("a, button")) return;
      onOpen?.(review);
    } : undefined}
  >
    <ReviewHeader review={review} compact cardActions={<div className={`review-card-actions${refreshable ? " review-card-actions-split" : ""}`}><button
      aria-label={`Delete review ${review.id}`}
      className="review-delete"
      disabled={deleting}
      onClick={() => onDelete(review)}
      title="Delete review and cached narrative"
    >
      <Trash2 aria-hidden="true" size={16} />
    </button>
    {refreshable && <RefreshReviewButton id={review.id} agentId={review.agentId} disabled={deleting || review.status === "preparing" || review.status === "pending"} />}
    </div>}>
      <ReviewProgress status={review.status} updating={review.updating} progress={review.progress} error={review.error} />
    </ReviewHeader>
  </article>;
}
