import { LoaderCircle } from "lucide-react";

export type ReviewStatus = "preparing" | "pending" | "ready" | "failed";

export function ReviewProgress({ status, updating = false, progress, error }: {
  status: ReviewStatus; updating?: boolean; progress?: string | null; error?: string | null;
}) {
  if (status === "ready") return null;
  const active = status === "preparing" || status === "pending";
  return <div className={`review-state review-state-${status}`} role="status">
    {active ? <LoaderCircle aria-hidden="true" className="progress-spinner" size={15} /> : <span className="failure-dot" />}
    {active && <strong className="review-progress-label">{updating ? "Updating" : "Importing"}</strong>}
    <span>{active ? status === "preparing" ? "Preparing review" : progress ?? "Preparing ingestion" : error ?? "Ingestion failed"}</span>
  </div>;
}
