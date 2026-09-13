import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createCommentHover } from "../src/web/comment-hover";

afterEach(() => vi.useRealTimers());

test("notifies only the icons whose visibility changes", () => {
  const hover = createCommentHover();
  const first = vi.fn(); const second = vi.fn(); const unrelated = vi.fn();
  hover.subscribe("first", first); hover.subscribe("second", second); hover.subscribe("unrelated", unrelated);
  hover.show("first");
  for (let i = 0; i < 100; i += 1) hover.show("first");
  assert.equal(first.mock.calls.length, 1);
  assert.equal(second.mock.calls.length, 0);
  hover.show("second");
  assert.equal(first.mock.calls.length, 2);
  assert.equal(second.mock.calls.length, 1);
  assert.equal(unrelated.mock.calls.length, 0);
  assert.equal(hover.isActive("first"), false);
  assert.equal(hover.isActive("second"), true);
});

test("keeps the icon available while crossing the gutter and cancels an old dismissal", () => {
  vi.useFakeTimers();
  const hover = createCommentHover();
  hover.show("first"); hover.leave("first");
  vi.advanceTimersByTime(300);
  assert.equal(hover.isActive("first"), true);
  hover.show("first");
  vi.advanceTimersByTime(400);
  assert.equal(hover.isActive("first"), true);
  hover.leave("first"); hover.show("second"); hover.leave("first");
  vi.advanceTimersByTime(400);
  assert.equal(hover.isActive("second"), true);
  hover.leave("second");
  vi.advanceTimersByTime(400);
  assert.equal(hover.isActive("second"), false);
});

test("clears the icon and timer when scrolling or changing steps", () => {
  vi.useFakeTimers();
  const hover = createCommentHover();
  const listener = vi.fn();
  hover.subscribe("first", listener);
  hover.show("first"); hover.leave("first"); hover.clear();
  assert.equal(hover.isActive("first"), false);
  assert.equal(vi.getTimerCount(), 0);
  hover.clear();
  assert.equal(listener.mock.calls.length, 2);
});

test("removes subscriptions when an icon unmounts", () => {
  const hover = createCommentHover();
  const listener = vi.fn();
  const unsubscribe = hover.subscribe("first", listener);
  unsubscribe(); hover.show("first"); hover.clear();
  assert.equal(listener.mock.calls.length, 0);
});
