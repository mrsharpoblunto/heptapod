import { prepareReview } from "@thestraylight/heptapod-core/prepare";
import { captureReviewSource, ingestReviewSource, selectReviewSource, type SourceSelector } from "@thestraylight/heptapod-core/commands";
import { publishReviewDraft } from "@thestraylight/heptapod-core/review-draft-service";

interface Work {
  root: string; operation: "prepare" | "capture" | "ingest" | "publish";
  id?: string; agent?: string | null; selection?: SourceSelector; version?: number; refresh?: boolean;
}

function sendResult(message: { type: "result"; status: "ready" | "failed"; result?: unknown; error?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) { reject(new Error("The review worker lost its API connection.")); return; }
    process.send(message, (error) => { if (error) reject(error); else resolve(); });
  });
}

process.once("message", async (work: Work) => {
  const { root, operation, id, agent, selection, version, refresh } = work;
  process.env.HEPTAPOD_ROOT = root;
  try {
    let result: unknown;
    if (operation === "prepare") result = await prepareReview(root, id!, agent, undefined, refresh);
    else if (operation === "publish") result = await publishReviewDraft(id!, version!);
    else {
      const source = selectReviewSource(root, selection!);
      // Register the resolved ID before any writes, including revision-range jobs.
      await new Promise<void>((resolve) => {
        process.once("message", () => resolve());
        process.send?.({ type: "review", id: source.id });
      });
      result = operation === "capture" ? captureReviewSource(root, source) : ingestReviewSource(root, source);
    }
    // A review payload can exceed the IPC buffer; flush it before disconnecting.
    await sendResult({ type: "result", status: "ready", result });
  } catch (error) {
    await sendResult({ type: "result", status: "failed", error: error instanceof Error ? error.message : String(error) });
  } finally { if (process.connected) process.disconnect(); }
});
