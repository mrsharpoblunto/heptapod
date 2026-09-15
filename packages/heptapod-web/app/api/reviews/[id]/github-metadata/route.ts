import { NextResponse } from "next/server";
import { getReview } from "@thestraylight/heptapod-core/database";
import {
  githubSourceFromPullRequestUrl,
  loadGitHubPullRequestMetadata,
} from "../../../../../src/web/github-metadata";
import { repositoryDatabaseForRequest } from "../../../../../src/web/repository-request";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const databasePath = repositoryDatabaseForRequest(request);
  if (databasePath === null) return NextResponse.json({ metadata: null }, { status: 404 });
  const review = getReview(id, databasePath);
  if (!review) return NextResponse.json({ metadata: null }, { status: 404 });

  const source = review.payload?.source.github ?? githubSourceFromPullRequestUrl(review.sourceUrl);
  const metadata = await loadGitHubPullRequestMetadata(source);
  return NextResponse.json({ metadata }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
