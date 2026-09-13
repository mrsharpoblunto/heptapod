import assert from "node:assert/strict";
import { test } from "vitest";
import { codeCommentLocations, createReviewCommentStore, createReviewSelection, sameCommentLocations, sameItems, type DraftState } from "../src/web/review-comment-store";

const initial: DraftState = {
  draft: { id: "draft", reviewId: "review", head: "head", version: 1, summary: "", comments: [
    { id: "first", body: "", target: { kind: "line", stepId: "step", anchor: "first", path: "first.ts", side: "RIGHT", startLine: 2, endLine: 2 } },
    { id: "other", body: "Other comment", target: { kind: "line", stepId: "step", anchor: "other", path: "other.ts", side: "RIGHT", startLine: 1, endLine: 1 } },
  ], githubReviewId: null, githubUrl: null, publishedAt: null, publishing: false },
  preview: { body: "", threads: [], errors: [] },
};

test("typing and save responses preserve the selected code locations", () => {
  const store = createReviewCommentStore();
  store.update({ state: initial });
  const locations = createReviewSelection(store, (snapshot) => codeCommentLocations(snapshot, "step", "first.ts"), sameCommentLocations, null);
  const selected = locations.getSnapshot();
  for (let i = 0; i < 100; i += 1) {
    store.update({ saving: true, state: { ...initial, draft: { ...initial.draft, comments: initial.draft.comments.map((comment) => comment.id === "first" ? { ...comment, body: `Text ${i}` } : comment) } } });
    assert.equal(locations.getSnapshot(), selected);
    store.update({ saving: false, error: i % 2 ? "Retry saving" : null });
    assert.equal(locations.getSnapshot(), selected);
  }
});

test("adding, moving, and removing code comments updates the affected file", () => {
  const store = createReviewCommentStore();
  store.update({ state: initial });
  const locations = createReviewSelection(store, (snapshot) => codeCommentLocations(snapshot, "step", "first.ts"), sameCommentLocations, null);
  const other = createReviewSelection(store, (snapshot) => codeCommentLocations(snapshot, "step", "other.ts"), sameCommentLocations, null);
  const otherSelected = other.getSnapshot();
  const previous = locations.getSnapshot();
  const moved = { ...initial.draft.comments[0], target: { ...initial.draft.comments[0].target, startLine: 3, endLine: 5 } };
  store.update({ state: { ...initial, draft: { ...initial.draft, comments: [moved, initial.draft.comments[1]] } } });
  assert.notEqual(locations.getSnapshot(), previous);
  assert.equal(other.getSnapshot(), otherSelected);
  store.update({ state: { ...initial, draft: { ...initial.draft, comments: [initial.draft.comments[1]] } } });
  assert.deepEqual(locations.getSnapshot(), []);
  store.update({ state: initial });
  assert.equal(locations.getSnapshot()[0].id, "first");
  assert.equal(other.getSnapshot(), otherSelected);
});

test("updates the presence indicator without changing code locations", () => {
  const store = createReviewCommentStore();
  store.update({ state: initial });
  const presence = createReviewSelection(store, (snapshot) => Boolean(snapshot.state?.draft.comments.some((comment) => comment.id === "first" && comment.body.trim())), Object.is, null);
  const otherComments = createReviewSelection(store, (snapshot) => snapshot.state?.draft.comments.filter((comment) => comment.id === "other") ?? [], sameItems, null);
  const otherSelected = otherComments.getSnapshot();
  assert.equal(presence.getSnapshot(), false);
  store.update({ state: { ...initial, draft: { ...initial.draft, comments: initial.draft.comments.map((comment) => comment.id === "first" ? { ...comment, body: "Text" } : comment) } } });
  assert.equal(presence.getSnapshot(), true);
  assert.equal(otherComments.getSnapshot(), otherSelected);
  store.update({ state: initial });
  assert.equal(presence.getSnapshot(), false);
});

test("keeps snapshots stable for unchanged writes and removes subscriptions", () => {
  const store = createReviewCommentStore();
  const server = store.getServerSnapshot();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  store.update({ saving: false });
  assert.equal(store.getSnapshot(), server);
  assert.equal(notifications, 0);
  store.update({ saving: true });
  assert.equal(notifications, 1);
  assert.equal(store.getServerSnapshot(), server);
  unsubscribe();
  store.update({ saving: false });
  assert.equal(notifications, 1);
});

test("retains the committed selection when a component creates a new selector", () => {
  const store = createReviewCommentStore();
  store.update({ state: initial });
  const first = createReviewSelection(store, (snapshot) => codeCommentLocations(snapshot, "step", "first.ts"), sameCommentLocations, null);
  const committed = first.getSnapshot();
  const rerendered = createReviewSelection(store, (snapshot) => codeCommentLocations(snapshot, "step", "first.ts"), sameCommentLocations, { value: committed });
  assert.equal(rerendered.getSnapshot(), committed);
  const changedFile = createReviewSelection(store, (snapshot) => codeCommentLocations(snapshot, "step", "other.ts"), sameCommentLocations, { value: committed });
  assert.notEqual(changedFile.getSnapshot(), committed);
});
