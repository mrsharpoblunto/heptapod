import { NextResponse } from "next/server";
import { saveReviewDraft } from "@thestraylight/heptapod/database";
import { isSameOrigin, loadDraftState } from "../../../../../src/web/review-draft-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
interface Context { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Context) {
  try {
    return NextResponse.json(await loadDraftState((await params).id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request, { params }: Context) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const text = await request.text();
    if (text.length > 2_000_000) throw new Error("The review draft is too large.");
    const body = JSON.parse(text);
    if (!Number.isSafeInteger(body.version)) throw new Error("Missing draft version.");
    const { id } = await params;
    if (body.summaryIsCombined !== undefined && typeof body.summaryIsCombined !== "boolean") throw new Error("Invalid review summary mode.");
    saveReviewDraft(id, body.version, body.summary, body.comments, undefined, body.summaryIsCombined);
    return NextResponse.json(await loadDraftState(id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
