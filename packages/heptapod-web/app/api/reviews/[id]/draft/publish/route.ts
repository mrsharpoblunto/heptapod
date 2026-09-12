import { NextResponse } from "next/server";
import { isSameOrigin, publishReviewDraft } from "../../../../../../src/web/review-draft-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const body = await request.json();
    if (!Number.isSafeInteger(body.version)) throw new Error("Missing draft version.");
    return NextResponse.json(await publishReviewDraft((await params).id, body.version));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
