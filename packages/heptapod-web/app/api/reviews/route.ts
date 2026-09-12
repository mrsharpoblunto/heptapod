import { NextResponse } from "next/server";
import { listReviews } from "@thestraylight/heptapod-core/database";
import { reviewSummary } from "../../../src/web/review-summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(listReviews().map(reviewSummary), { headers: { "Cache-Control": "no-store" } });
}
