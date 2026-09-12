import { Suspense } from "react";
import { listReviews } from "@thestraylight/heptapod-core/database";
import { reviewSummary } from "../src/web/review-summary";
import { ReviewIndex } from "../src/web/ReviewIndex";
import { GitHubMetadataProvider } from "../src/web/GitHubIdentity";
import { githubSourceFromPullRequestUrl, loadGitHubPullRequestMetadata } from "../src/web/github-metadata";
import { SetupChecklist } from "../src/web/SetupChecklist";
import { PullRequestLoadingSection } from "../src/web/OpenPullRequests";
import { OpenPullRequestsSection } from "../src/web/OpenPullRequestsSection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ReviewIndexPage({ searchParams }: { searchParams: Promise<{ includeClosed?: string }> }) {
  const reviews = listReviews();
  const metadata = Object.fromEntries(reviews.map((review) => [review.id,
    loadGitHubPullRequestMetadata(githubSourceFromPullRequestUrl(review.sourceUrl)),
  ]));
  const includeClosed = (await searchParams).includeClosed === "true";
  return <GitHubMetadataProvider promises={metadata}><ReviewIndex
    setup={<SetupChecklist />}
    openPullRequests={<Suspense fallback={<PullRequestLoadingSection includeClosed={includeClosed} />}>
      <OpenPullRequestsSection includeClosed={includeClosed} importedIds={reviews.map((review) => review.id)} />
    </Suspense>}
    reviews={reviews.map(reviewSummary)} /></GitHubMetadataProvider>;
}
