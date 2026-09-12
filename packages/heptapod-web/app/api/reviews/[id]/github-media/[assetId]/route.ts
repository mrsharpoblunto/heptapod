import { NextResponse } from "next/server";
import { getReview } from "@thestraylight/heptapod/database";
import { resolveGitHubVideoUrl } from "../../../../../../src/web/github-metadata";
import type { Evidence } from "@thestraylight/heptapod/types";

interface RouteContext {
  params: Promise<{ id: string; assetId: string }>;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function reviewEvidence(review: NonNullable<ReturnType<typeof getReview>>): Evidence[] {
  return (review.payload?.steps ?? []).flatMap((step) => [
    ...(step.evidence ?? []),
    ...step.checks.automated.flatMap((check) => check.evidence ?? []),
    ...step.checks.manual.flatMap((check) => check.evidence ?? []),
  ]);
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id, assetId } = await params;
  const review = getReview(id);
  const github = review?.payload?.source.github;
  const evidence = review && reviewEvidence(review).find((item) => item.kind === "video" && item.url.includes(assetId));
  if (!review || !github || !evidence) return NextResponse.json({ error: "Video evidence not found" }, { status: 404 });

  const mediaUrl = await resolveGitHubVideoUrl(github, assetId);
  if (!mediaUrl) return NextResponse.json({ error: "Video source is unavailable" }, { status: 404 });

  const range = request.headers.get("range");
  const response = await fetch(mediaUrl, { headers: range ? { Range: range } : undefined, cache: "no-store" });
  if (!response.ok && response.status !== 206) {
    return NextResponse.json({ error: "Video source could not be loaded" }, { status: 502 });
  }
  const headers = new Headers();
  for (const name of ["accept-ranges", "content-length", "content-range", "content-type"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}
