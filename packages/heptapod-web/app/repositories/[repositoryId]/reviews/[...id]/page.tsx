import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getReview } from "@thestraylight/heptapod-core/database";
import { getRepository, repositoryDatabasePath } from "@thestraylight/heptapod-core/repositories";
import { GitHubMetadataProvider, GitHubMetadataStoreProvider } from "../../../../../src/web/GitHubIdentity";
import { githubSourceFromPullRequestUrl, loadGitHubPullRequestMetadata } from "../../../../../src/web/github-metadata";
import { PendingReview } from "../../../../../src/web/PendingReview";
import { RepositoryProvider } from "../../../../../src/web/RepositoryContext";
import { reviewSummary } from "../../../../../src/web/review-summary";
import { ReviewViewer } from "../../../../../src/web/ReviewViewer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReviewPageProps { params: Promise<{ repositoryId: string; id: string[] }> }

function resolveReview(repositoryId: string, id: string) {
  const repository = getRepository(repositoryId);
  return repository ? { repository, review: getReview(id, repositoryDatabasePath(repository.id)) } : null;
}

export async function generateMetadata({ params }: ReviewPageProps): Promise<Metadata> {
  const { repositoryId, id: parts } = await params;
  const resolved = resolveReview(repositoryId, parts.join("/"));
  return resolved?.review ? { title: resolved.review.title, description: resolved.review.summary } : {};
}

export default async function RepositoryReviewPage({ params }: ReviewPageProps) {
  const { repositoryId, id: parts } = await params;
  const id = parts.join("/");
  const resolved = resolveReview(repositoryId, id);
  if (!resolved?.review) notFound();
  const { repository, review } = resolved;
  const source = review.payload?.source.github ?? githubSourceFromPullRequestUrl(review.sourceUrl);
  const content = !review.payload && (review.status === "preparing" || review.status === "pending" || review.status === "failed")
    ? <PendingReview review={reviewSummary(review)} />
    : review.payload
      ? <ReviewViewer data={review.payload} reviewId={id} updatedAt={review.updatedAt} status={review.status} progress={review.progress} updating={review.status === "pending" || review.status === "preparing"} />
      : null;
  if (!content) notFound();
  return <RepositoryProvider id={repository.id}><GitHubMetadataStoreProvider repositoryId={repository.id}><GitHubMetadataProvider promises={{ [id]: loadGitHubPullRequestMetadata(source) }}>
    {content}
  </GitHubMetadataProvider></GitHubMetadataStoreProvider></RepositoryProvider>;
}
