import { NextResponse } from "next/server";
import { listReviews } from "@thestraylight/heptapod-core/database";
import { connectedRepository } from "../../../src/web/connected-repository";
import { loadPullRequestPage } from "../../../src/web/setup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor && cursor.length > 2048) return NextResponse.json({ error: "Invalid pagination cursor." }, { status: 400 });
  try {
    const repo = await connectedRepository();
    if (!repo.githubUrl) return NextResponse.json({ error: "Connect a GitHub repository to load pull requests." }, { status: 400 });
    const page = await loadPullRequestPage(repo.name, url.searchParams.get("includeClosed") === "true", cursor);
    const imported = listReviews();
    const ids = new Set(imported.map((review) => review.id));
    const urls = new Set(imported.map((review) => review.sourceUrl));
    return NextResponse.json({ ...page, pullRequests: page.pullRequests.filter((pr) => !ids.has(String(pr.number)) && !urls.has(pr.url)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load pull requests." }, { status: 502 });
  }
}
