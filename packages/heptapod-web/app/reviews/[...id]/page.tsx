import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getReview } from "@thestraylight/heptapod/database";
import { PendingReview } from "../../../src/web/PendingReview";
import { ReviewViewer } from "../../../src/web/ReviewViewer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReviewPageProps {
  params: Promise<{ id: string[] }>;
}

export async function generateMetadata({ params }: ReviewPageProps): Promise<Metadata> {
  const id = (await params).id.join("/");
  const review = getReview(id);
  return review ? { title: review.title, description: review.summary } : {};
}

export default async function ReviewPage({ params }: ReviewPageProps) {
  const id = (await params).id.join("/");
  const review = getReview(id);
  if (!review) notFound();
  if (review.status === "pending" || review.status === "failed") {
    return <PendingReview
      id={review.id}
      title={review.title}
      status={review.status}
      progress={review.progress}
      error={review.error}
    />;
  }
  if (!review.payload) notFound();
  return <ReviewViewer data={review.payload} reviewId={id} updatedAt={review.updatedAt} />;
}
