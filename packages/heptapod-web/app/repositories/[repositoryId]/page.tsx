import { notFound } from "next/navigation";
import { listReviews } from "@thestraylight/heptapod-core/database";
import { getRepository, repositoryDatabasePath } from "@thestraylight/heptapod-core/repositories";
import { GitHubMetadataProvider, GitHubMetadataStoreProvider } from "../../../src/web/GitHubIdentity";
import { githubSourceFromPullRequestUrl, loadGitHubPullRequestMetadata } from "../../../src/web/github-metadata";
import { RepositoryProvider } from "../../../src/web/RepositoryContext";
import { ReviewIndex } from "../../../src/web/ReviewIndex";
import { reviewSummary } from "../../../src/web/review-summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function RepositoryReviewsPage({ params }: { params: Promise<{ repositoryId: string }> }) {
  const { repositoryId } = await params;
  const repository = getRepository(repositoryId);
  if (!repository) notFound();
  const reviews = listReviews(repositoryDatabasePath(repository.id));
  const metadata = Object.fromEntries(reviews.map((review) => [review.id,
    loadGitHubPullRequestMetadata(githubSourceFromPullRequestUrl(review.sourceUrl)),
  ]));
  return <RepositoryProvider id={repository.id}><GitHubMetadataStoreProvider repositoryId={repository.id}><GitHubMetadataProvider promises={metadata}>
    <ReviewIndex repositoryName={repository.name} reviews={reviews.map(reviewSummary)} />
  </GitHubMetadataProvider></GitHubMetadataStoreProvider></RepositoryProvider>;
}
