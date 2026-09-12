import type { PatchFile, RenderModel, ReviewComment, ReviewDraft, ReviewDraftPreview, ReviewThreadPreview } from "./types.js";
import { splitPatchFiles } from "./patch.js";

export function validateReviewComments(model: RenderModel, summary: unknown, comments: unknown): asserts comments is ReviewComment[] {
  if (!model.source.github) throw new Error("Review drafts are only available for GitHub pull requests.");
  if (typeof summary !== "string" || summary.length > 60_000) throw new Error("The review summary must be at most 60,000 characters.");
  if (!Array.isArray(comments) || comments.length > 500) throw new Error("A review can contain at most 500 comments.");
  const ids = new Set<string>();
  for (const comment of comments as ReviewComment[]) {
    if (!comment || typeof comment.id !== "string" || !/^[\w-]{1,100}$/.test(comment.id) || ids.has(comment.id)) throw new Error("Invalid or duplicate comment ID.");
    ids.add(comment.id);
    if (typeof comment.body !== "string" || !comment.body.trim() || comment.body.length > 60_000) throw new Error("Comments must contain between 1 and 60,000 characters.");
    const target = comment.target;
    if (!target || typeof target.anchor !== "string" || target.anchor.length > 2000) throw new Error("Invalid comment anchor.");
    const step = model.steps.find((step) => step.id === target.stepId);
    if (!step) throw new Error("The comment's step is no longer available. Reload the review.");
    if (target.kind === "section" || target.kind === "quote") {
      if (typeof target.section !== "string" || target.section.length > 2000) throw new Error("Invalid comment section.");
      if (target.kind === "quote" && (typeof target.quote !== "string" || !target.quote.trim() || target.quote.length > 60_000
        || !Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end) || target.start < 0 || target.end <= target.start)) throw new Error("Invalid quote selection.");
    } else if (target.kind === "file" || target.kind === "line") {
      const paths = new Set([
        ...(model.source.files ?? []).flatMap((file) => [file.path, ...(file.from ? [file.from] : [])]),
        ...model.steps.flatMap((step) => [...step.fileDiffs, ...(step.referenceFiles ?? [])].map((file) => file.path)),
      ]);
      if (typeof target.path !== "string" || !paths.has(target.path)) throw new Error("The comment's file is not part of this review.");
      if (target.kind === "line" && (!Number.isSafeInteger(target.startLine) || !Number.isSafeInteger(target.endLine)
        || target.startLine < 1 || target.endLine < target.startLine || target.endLine - target.startLine > 10_000
        || !["LEFT", "RIGHT"].includes(target.side))) throw new Error("Invalid comment line range.");
    } else throw new Error("Unknown comment type.");
  }
}

// Preserve line identity while translating through the narrative's reordered patches.
export function translateLine(patch: string, line: number, reverse: boolean): number | null {
  let old = 0;
  let next = 0;
  let offset = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      old = Number(hunk[1]) + (hunk[2] === "0" ? 1 : 0);
      next = Number(hunk[3]) + (hunk[4] === "0" ? 1 : 0);
      if (line < (reverse ? next : old)) return line + offset;
      inHunk = true;
    } else if (inHunk && /^[ +-]/.test(text)) {
      const consumesOld = text[0] !== "+";
      const consumesNew = text[0] !== "-";
      if ((reverse ? consumesNew : consumesOld) && line === (reverse ? next : old)) {
        return (reverse ? consumesOld : consumesNew) ? (reverse ? old : next) : null;
      }
      if (consumesOld) old += 1;
      if (consumesNew) next += 1;
      offset = reverse ? old - next : next - old;
    }
  }
  return line + offset;
}

function sourceAtStep(model: RenderModel, stepIndex: number, path: string, side: "LEFT" | "RIGHT"): string | null {
  const current = model.steps[stepIndex];
  const changed = current.fileDiffs.find((file) => file.path === path);
  if (changed) return (side === "LEFT" ? changed.beforeContent : changed.afterContent) ?? null;
  for (let index = stepIndex; index >= 0; index -= 1) {
    const step = model.steps[index];
    const file = [...step.fileDiffs, ...(step.referenceFiles ?? [])].find((file) => file.path === path);
    if (file) return file.afterContent ?? null;
  }
  return null;
}

function lineInDiff(file: PatchFile, line: number, side: "LEFT" | "RIGHT"): boolean {
  for (const match of file.patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[side === "LEFT" ? 1 : 3]);
    const count = Number(match[side === "LEFT" ? 2 : 4] ?? 1);
    if (line >= start && line < start + count) return true;
  }
  return false;
}

function mapRange(model: RenderModel, target: Extract<ReviewComment["target"], { kind: "line" }>, destination: "LEFT" | "RIGHT"): number[] | null {
  const index = model.steps.findIndex((step) => step.id === target.stepId);
  let lines: Array<number | null> = Array.from({ length: target.endLine - target.startLine + 1 }, (_, i) => target.startLine + i);
  const boundary = index + (target.side === "RIGHT" ? 1 : 0);
  const steps = destination === "RIGHT" ? model.steps.slice(boundary) : model.steps.slice(0, boundary).reverse();
  for (const step of steps) {
    const file = step.fileDiffs.find((file) => file.path === target.path);
    if (!file) continue;
    lines = lines.map((line) => line === null ? null : translateLine(file.patch, line, destination === "LEFT"));
  }
  if (lines.some((line, index) => line === null || line !== (lines[0] ?? 0) + index)) return null;
  return lines as number[];
}

export function buildReviewDraftPreview(model: RenderModel, draft: Pick<ReviewDraft, "comments" | "summary" | "head" | "summaryIsCombined">, sourcePatch: string): ReviewDraftPreview {
  const body: string[] = draft.summary.trim() ? [draft.summary.trim()] : [];
  const threads: ReviewThreadPreview[] = [];
  const errors: string[] = [];
  if (draft.head !== model.source.head) errors.push("The PR revision changed after these comments were saved. Review the new revision before publishing.");
  const files = splitPatchFiles(sourcePatch);
  for (const step of model.steps) {
    const comments = draft.comments.filter((comment) => comment.target.stepId === step.id);
    const narrative = comments.filter((comment) => comment.target.kind === "section" || comment.target.kind === "quote");
    if (narrative.length) {
      body.push(`## ${step.title}`);
      const sections = [step.title, ...new Set(narrative.map((comment) => "section" in comment.target ? comment.target.section : "").filter((section) => section !== step.title))];
      for (const section of sections) {
        if (section && section !== step.title) body.push(`### ${section}`);
        const matching = narrative.filter((comment) => "section" in comment.target && comment.target.section === section);
        for (const comment of [...matching.filter((c) => c.target.kind === "section"), ...matching.filter((c) => c.target.kind === "quote")]) {
          if (comment.target.kind === "quote") body.push(comment.target.quote.split("\n").map((line) => `> ${line}`).join("\n"));
          body.push(comment.body.trim());
        }
      }
    }
    for (const comment of comments) {
      const target = comment.target;
      if (target.kind !== "file" && target.kind !== "line") continue;
      const sourceFile = files.find((file) => file.path === target.path);
      const preview: ReviewThreadPreview = { commentId: comment.id, body: comment.body, path: target.path, subjectType: target.kind === "file" ? "FILE" : "LINE", snippet: "" };
      if (!sourceFile) preview.error = "This file is not changed in the GitHub PR. Move this comment to the step summary.";
      else if (target.kind === "line") {
        const source = sourceAtStep(model, model.steps.indexOf(step), target.path, target.side);
        preview.snippet = source?.split("\n").slice(target.startLine - 1, target.endLine).join("\n") ?? "";
        const sides = target.side === "RIGHT" ? ["RIGHT", "LEFT"] as const : ["LEFT", "RIGHT"] as const;
        for (const side of sides) {
          const lines = mapRange(model, target, side);
          if (!lines || !lineInDiff(sourceFile, lines[0], side) || !lineInDiff(sourceFile, lines.at(-1)!, side)) continue;
          preview.side = side;
          preview.line = lines.at(-1)!;
          if (lines.length > 1) preview.startLine = lines[0];
          break;
        }
        if (!preview.line) preview.error = "These lines are not available in the GitHub PR diff. Choose another range or make a file comment.";
      }
      if (preview.error) errors.push(`${target.path}: ${preview.error}`);
      threads.push(preview);
    }
  }
  if (draft.comments.some((comment) => !model.steps.some((step) => step.id === comment.target.stepId))) errors.push("Some comments refer to steps that are no longer available.");
  const combined = draft.summaryIsCombined ? draft.summary : body.join("\n\n");
  if (combined.length > 60_000) errors.push("The combined review summary exceeds 60,000 characters.");
  return { body: combined, threads, errors };
}
