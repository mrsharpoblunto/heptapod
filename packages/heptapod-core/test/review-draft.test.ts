import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { buildReviewDraftPreview, translateLine } from "../src/tool/review-draft.js";
import { beginReviewUpdate, claimReviewDraftPublication, deleteReview, failReviewIngestion, finishReviewDraftPublication, getReviewDraft, recordGitHubDraft, saveReviewDraft, upsertReview } from "../src/tool/database.js";
import type { RenderModel, ReviewComment } from "../src/tool/types.js";

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });
const path = "test/example.test.ts";
const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n first\n+new test\n last\n`;
const laterPatch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n+import\n first\n new test\n last\n`;
const sourcePatch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,4 @@\n+import\n first\n+new test\n last\n`;
const model: RenderModel = {
  title: "Example", summary: "Example review", source: { base: "a".repeat(40), head: "b".repeat(40), diff: "source.diff", files: [{ path, status: "M" }],
    github: { number: 42, repositoryUrl: "https://github.com/example/project", pullRequestUrl: "https://github.com/example/project/pull/42" }, stats: { additions: 2, deletions: 0, files: 1 } },
  verification: { base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40), sourceBytes: 0, patchSteps: 2, exact: true },
  steps: [
    { id: "tests", number: 1, title: "Specify behavior", kind: "tests", body: "An explanation", patch, checks: { automated: [], manual: [] }, stats: { additions: 1, deletions: 0, files: 1 },
      fileDiffs: [{ path, patch, beforeContent: "first\nlast\n", afterContent: "first\nnew test\nlast\n" }] },
    { id: "implementation", number: 2, title: "Implement behavior", kind: "implementation", body: "", patch: laterPatch, checks: { automated: [], manual: [] }, stats: { additions: 1, deletions: 0, files: 1 },
      fileDiffs: [{ path, patch: laterPatch, beforeContent: "first\nnew test\nlast\n", afterContent: "import\nfirst\nnew test\nlast\n" }] },
  ],
};
const codeComment: ReviewComment = { id: "code", body: "Why this assertion?", target: { kind: "line", stepId: "tests", anchor: "code:test", path, side: "RIGHT", startLine: 2, endLine: 3 } };

test("maps narrative ranges through later changes and keeps code comments out of the summary", () => {
  const preview = buildReviewDraftPreview(model, { head: model.source.head, summary: "Looks useful.", comments: [codeComment] }, sourcePatch);
  assert.equal(preview.body, "Looks useful.");
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.threads[0], { commentId: "code", body: codeComment.body, path, subjectType: "LINE", side: "RIGHT", startLine: 3, line: 4, snippet: "new test\nlast" });
});

test("groups step notes before quote pairs under the correct section", () => {
  const comments: ReviewComment[] = [
    { id: "quote", body: "Why?", target: { kind: "quote", stepId: "tests", anchor: "body", section: "Boundary cases", quote: "one\ntwo", start: 0, end: 7 } },
    { id: "section", body: "A general question.", target: { kind: "section", stepId: "tests", anchor: "section", section: "Specify behavior" } },
    { id: "file", body: "Check the whole file.", target: { kind: "file", stepId: "tests", anchor: "file", path } },
  ];
  const preview = buildReviewDraftPreview(model, { head: model.source.head, summary: "Summary", comments }, sourcePatch);
  assert.match(preview.body, /^Summary\n\n## Specify behavior/);
  assert.match(preview.body, /### Boundary cases\n\n> one\n> two\n\nWhy\?/);
  assert.ok(preview.body.includes("A general question."));
  assert.ok(preview.body.indexOf("A general question.") < preview.body.indexOf("### Boundary cases"));
  assert.equal(preview.threads[0].subjectType, "FILE");
  assert.doesNotMatch(preview.body, /Check the whole file/);
});

test("line translation handles zero-context insertions and deletions without guessing deleted lines", () => {
  assert.equal(translateLine("@@ -0,0 +1,2 @@\n+a\n+b\n", 1, false), 3);
  assert.equal(translateLine("@@ -2,0 +3,1 @@\n+new\n", 2, false), 2);
  assert.equal(translateLine("@@ -2,0 +3,1 @@\n+new\n", 3, false), 4);
  assert.equal(translateLine("@@ -2,0 +3,1 @@\n+new\n", 3, true), null);
  assert.equal(translateLine("@@ -2,1 +1,0 @@\n-old\n", 2, false), null);
  assert.equal(translateLine("@@ -2,1 +1,0 @@\n-old\n", 2, true), 3);
});

test("marks ranges missing from the PR and stale revisions as unpublishable", () => {
  const bad = { ...codeComment, target: { ...codeComment.target, startLine: 50, endLine: 51 } } as ReviewComment;
  const preview = buildReviewDraftPreview(model, { head: "old", summary: "", comments: [bad] }, sourcePatch);
  assert.equal(preview.errors.length, 2);
  assert.ok(preview.threads[0].error);
  assert.equal(preview.threads[0].line, undefined);
});

test("persists comments, rejects stale saves, and deletes drafts with their review", () => {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-draft-")); directories.push(directory);
  const database = join(directory, "reviews.sqlite");
  upsertReview("42", model, database);
  const draft = getReviewDraft("42", database);
  const saved = saveReviewDraft("42", draft.version, "Final summary", [codeComment], database);
  assert.deepEqual(getReviewDraft("42", database).comments, [codeComment]);
  assert.equal(saved.version, draft.version + 1);
  assert.throws(() => saveReviewDraft("42", draft.version, "Lost update", [], database), /another tab/);
  claimReviewDraftPublication("42", saved.version, database);
  assert.throws(() => claimReviewDraftPublication("42", saved.version, database), /already being published/);
  assert.throws(() => saveReviewDraft("42", saved.version, "changed", [], database), /being published/);
  recordGitHubDraft("42", "remote", "https://github.com/example/project/pull/42/files", database);
  finishReviewDraftPublication("42", false, database);
  assert.equal(getReviewDraft("42", database).githubReviewId, "remote");
  assert.equal(getReviewDraft("42", database).publishing, false);
  finishReviewDraftPublication("42", true, database);
  assert.ok(getReviewDraft("42", database).publishedAt);
  deleteReview("42", database);
  upsertReview("42", model, database);
  assert.deepEqual(getReviewDraft("42", database).comments, []);
});

test.each([model.source.head, "d".repeat(40)])("successful updates clear the local draft and reject stale saves with head %s", (head) => {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-draft-reset-")); directories.push(directory);
  const database = join(directory, "reviews.sqlite");
  upsertReview("42", model, database);
  upsertReview("43", model, database);
  const draft = getReviewDraft("42", database);
  const saved = saveReviewDraft("42", draft.version, "Pending summary", [codeComment], database, true);
  const other = getReviewDraft("43", database);
  const otherSaved = saveReviewDraft("43", other.version, "Keep this summary", [codeComment], database);

  assert.equal(beginReviewUpdate("42", database), true);
  failReviewIngestion("42", "Update failed", database);
  const db = new DatabaseSync(database);
  try {
    const row = db.prepare("SELECT summary, comments_json FROM review_drafts WHERE review_id = ?").get("42")!;
    assert.equal(row.summary, saved.summary);
    assert.deepEqual(JSON.parse(row.comments_json as string), [codeComment]);
  } finally { db.close(); }

  assert.equal(beginReviewUpdate("42", database), true);
  upsertReview("42", { ...model, source: { ...model.source, head } }, database);
  const fresh = getReviewDraft("42", database);
  assert.notEqual(fresh.id, saved.id);
  assert.equal(fresh.head, head);
  assert.equal(fresh.version, saved.version + 1);
  assert.equal(fresh.summary, "");
  assert.equal(fresh.summaryIsCombined, false);
  assert.deepEqual(fresh.comments, []);
  assert.equal(fresh.githubReviewId, null);
  assert.equal(fresh.githubUrl, null);
  assert.equal(fresh.publishedAt, null);
  assert.equal(fresh.publishing, false);
  assert.throws(() => saveReviewDraft("42", saved.version, saved.summary, saved.comments, database), /another tab/);
  assert.deepEqual(getReviewDraft("43", database), otherSaved);
  assert.equal(saveReviewDraft("42", fresh.version, "New feedback", [codeComment], database).summary, "New feedback");
});

test("rejects drafts for non-GitHub reviews and invalid comment anchors", () => {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-draft-")); directories.push(directory);
  const database = join(directory, "reviews.sqlite");
  upsertReview("42", { ...model, source: { ...model.source, github: undefined } }, database);
  assert.throws(() => getReviewDraft("42", database), /only available for GitHub/);
  upsertReview("42", model, database);
  getReviewDraft("42", database);
  assert.throws(() => saveReviewDraft("42", 0, "", [{ ...codeComment, target: { ...codeComment.target, stepId: "missing" } }], database), /step is no longer available/);
  assert.throws(() => saveReviewDraft("42", 0, "", [codeComment, codeComment], database), /duplicate/);
});
