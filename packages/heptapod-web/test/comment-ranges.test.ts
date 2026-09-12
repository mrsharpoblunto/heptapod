import assert from "node:assert/strict";
import { test } from "vitest";
import type { ReviewComment, ReviewCommentTarget } from "@thestraylight/heptapod-core/types";
import { mergeCodeComments, reconcileSummary } from "../src/web/ReviewComments";

const target: Extract<ReviewCommentTarget, { kind: "line" }> = { kind: "line", stepId: "tests", anchor: "code", path: "test.ts", side: "RIGHT", startLine: 4, endLine: 8 };
const comment = (id: string, body: string, startLine: number, endLine: number): ReviewComment => ({ id, body, target: { ...target, startLine, endLine } });

test("merges all overlapping comments in line order and preserves unrelated comments", () => {
  const original: ReviewComment[] = [comment("later", "Later question", 7, 10), comment("earlier", "Earlier question", 2, 4),
    comment("outside", "Unrelated question", 11, 12), { ...comment("old", "Original-side question", 4, 8), target: { ...target, side: "LEFT" } },
    { ...comment("step", "Another step", 4, 8), target: { ...target, stepId: "implementation" } }];
  const merged = mergeCodeComments(original, target, "new");
  assert.equal(merged.id, "earlier");
  assert.deepEqual(merged.comments.map((comment) => comment.id), ["outside", "old", "step", "earlier"]);
  assert.equal(merged.comments.at(-1)?.body, "Earlier question\n\nLater question");
  assert.deepEqual(merged.comments.at(-1)?.target, target);
  assert.equal(original.length, 5);
});

test("opens a new blank inline row and reuses the existing comment on repeated selection", () => {
  const blank = mergeCodeComments([], target, "new");
  assert.equal(blank.comments[0].body, "");
  const repeated = mergeCodeComments(blank.comments, target, "second");
  assert.equal(repeated.id, "new");
  assert.equal(repeated.comments.length, 1);
});


test("keeps later section edits in the combined summary without losing authored text", () => {
  const first: ReviewComment = { id: "section", body: "First question", target: { kind: "section", stepId: "tests", anchor: "body", section: "Tests" } };
  const added: ReviewComment = { ...first, id: "second", body: "Another question" };
  const summary = "My introduction.\n\n## Tests\n\nFirst question\n\nMy conclusion.";
  const updated = reconcileSummary(summary, [first], [{ ...first, body: "Updated question" }, added], []);
  assert.match(updated, /My introduction/);
  assert.match(updated, /My conclusion/);
  assert.match(updated, /Updated question/);
  assert.match(updated, /Another question/);
  assert.doesNotMatch(updated, /First question/);
  assert.doesNotMatch(reconcileSummary(summary, [first], [], []), /First question/);
});
