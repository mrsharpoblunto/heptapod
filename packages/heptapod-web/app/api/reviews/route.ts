import { deleteReview, getReview } from "@thestraylight/heptapod/database";
import { removeReviewRun } from "@thestraylight/heptapod/cache";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("review");
  if (!id) return NextResponse.json({ error: "Missing review ID." }, { status: 400 });
  try {
    const review = getReview(id);
    if (!review) return NextResponse.json({ error: `Review ${id} was not found.` }, { status: 404 });
    return NextResponse.json({
      id: review.id,
      status: review.status,
      progress: review.progress,
      error: review.error,
      updatedAt: review.updatedAt,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("review");
  if (!id) return NextResponse.json({ error: "Missing review ID." }, { status: 400 });
  try {
    const deletedReview = deleteReview(id);
    const deletedRun = removeReviewRun(id);
    if (!deletedReview && !deletedRun) {
      return NextResponse.json({ error: `Review ${id} was not found.` }, { status: 404 });
    }
    return NextResponse.json({ id, deletedReview, deletedRun });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
