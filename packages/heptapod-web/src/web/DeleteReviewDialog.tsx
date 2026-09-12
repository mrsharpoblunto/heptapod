"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { ReviewSummary } from "./ReviewCard";

export function DeleteReviewDialog({ review, onCancel, onConfirm }: {
  review: ReviewSummary; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    cancel.current?.focus();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={dialog} className="delete-review-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); onCancel(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onCancel();
    }}>
    <button type="button" className="delete-dialog-dismiss" aria-label="Cancel deletion" onClick={onCancel}><X size={20} aria-hidden="true" /></button>
    <h2 id={titleId}>Delete review?</h2>
    <p className="delete-dialog-review">{review.title || `Review ${review.id}`}</p>
    <p id={descriptionId}>This removes the review and its cached narrative files. Any active import or update will be cancelled.</p>
    <div className="delete-dialog-actions">
      <button ref={cancel} type="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="delete-dialog-confirm" onClick={onConfirm}>Delete review</button>
    </div>
  </dialog>;
}
