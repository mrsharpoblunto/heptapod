import { NextResponse } from "next/server";
import { listReviews } from "@thestraylight/heptapod-core/database";
import { getRepository, repositoryDatabasePath } from "@thestraylight/heptapod-core/repositories";
import { reviewSummary } from "../../../../../src/web/review-summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ repositoryId: string }> }) {
  const { repositoryId } = await params;
  if (!getRepository(repositoryId)) return NextResponse.json({ error: "Repository not found." }, { status: 404 });
  return NextResponse.json(listReviews(repositoryDatabasePath(repositoryId)).map(reviewSummary), { headers: { "Cache-Control": "no-store" } });
}
