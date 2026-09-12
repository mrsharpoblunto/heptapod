"use client";

import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { HeptapodBackdrop } from "./HeptapodBackdrop";

export function PendingReview({
  id,
  title,
  status,
  progress,
  error,
}: {
  id: string;
  title: string;
  status: "pending" | "failed";
  progress: string | null;
  error: string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    if (status !== "pending") return;
    const timer = window.setInterval(() => router.refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [router, status]);

  return <><HeptapodBackdrop /><main className="pending-review">
    <div className="pending-card">
      {status === "pending"
        ? <LoaderCircle aria-hidden="true" className="pending-spinner" size={24} />
        : <div className="pending-icon pending-icon-failed" />}
      <div>
        <div className="eyebrow">Review {id}</div>
        <h1>{title}</h1>
        <p>{status === "pending" ? progress ?? "Preparing ingestion" : error ?? "Ingestion failed."}</p>
        <span className={`status status-${status === "pending" ? "not-run" : "failing"}`}>
          {status === "pending" ? "Ingesting" : "Failed"}
        </span>
      </div>
      <Link href="/">All reviews</Link>
    </div>
  </main></>;
}
