"use client";

import { useToast } from "./Toasts";
import { createElement, useState } from "react";
import { DeleteReviewDialog } from "./DeleteReviewDialog";
import { useRouter } from "next/navigation";
import type { ReviewSummary } from "./ReviewCard";
import { useReviewList } from "./ReviewListContext";
import { repositoryServicePath, useRepositoryId } from "./RepositoryContext";

export function useDeleteReview(returnToIndex = false, onDeleted?: () => void) {
  const router = useRouter();
  const list = useReviewList();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [requested, setRequested] = useState<ReviewSummary | null>(null);
  const notify = useToast();
  const repositoryId = useRepositoryId();
  const deleteConfirmed = async (review: ReviewSummary) => {
    setDeleting(review.id);
    try {
      const response = await fetch(`${repositoryServicePath(repositoryId, "/reviews")}?review=${encodeURIComponent(review.id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? `Delete failed with HTTP ${response.status}`);
      }
      if (returnToIndex) router.replace(repositoryId ? `/repositories/${encodeURIComponent(repositoryId)}` : "/");
      if (onDeleted) onDeleted();
      else if (list) list.refresh();
      else router.refresh();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : String(caught));
    } finally { setDeleting(null); }
  };
  const remove = (review: ReviewSummary) => { if (!deleting) setRequested(review); };
  const confirmation = requested ? createElement(DeleteReviewDialog, {
    review: requested,
    onCancel: () => setRequested(null),
    onConfirm: () => { setRequested(null); void deleteConfirmed(requested); },
  }) : null;
  return { deleting, remove, confirmation };
}
