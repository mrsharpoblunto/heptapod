import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getReview } from "@thestraylight/heptapod-core/database";
import { GitHubMetadataProvider } from "../../../src/web/GitHubIdentity";
import { githubSourceFromPullRequestUrl, loadGitHubPullRequestMetadata } from "../../../src/web/github-metadata";
import { reviewSummary } from "../../../src/web/review-summary";
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
  if (!review.payload && (review.status === "preparing" || review.status === "pending" || review.status === "failed")) {
    return <GitHubMetadataProvider promises={{ [id]: loadGitHubPullRequestMetadata(githubSourceFromPullRequestUrl(review.sourceUrl)) }}>
      <PendingReview review={reviewSummary(review)} />
    </GitHubMetadataProvider>;
  }
  if (!review.payload) notFound();
  return <GitHubMetadataProvider promises={{ [id]: loadGitHubPullRequestMetadata(review.payload.source.github) }}><ReviewViewer data={review.payload} reviewId={id} updatedAt={review.updatedAt} status={review.status} progress={review.progress} updating={review.status === "pending" || review.status === "preparing"} /></GitHubMetadataProvider>;
}
