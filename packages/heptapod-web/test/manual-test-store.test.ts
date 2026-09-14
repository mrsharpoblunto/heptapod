import assert from "node:assert/strict";
import { test } from "vitest";
import { createManualTestStore } from "../src/web/manual-test-store";

const response = (testedChecks: string[]) => Response.json({ head: "head", testedChecks });

test("saved completion loads again after leaving and reopening a review", async () => {
  let saved: string[] = [];
  const request: typeof fetch = async (_url, options) => {
    if (options?.method === "PUT") {
      const { checkId, tested } = JSON.parse(String(options.body));
      saved = [...saved.filter(id => id !== checkId), ...(tested ? [checkId] : [])];
    }
    return response(saved);
  };
  const store = createManualTestStore("head", "/manual-tests", request);
  await store.load(); await store.setTested("first", true);
  const reopened = createManualTestStore("head", "/manual-tests", request);
  await reopened.load();
  assert.deepEqual(reopened.getSnapshot().testedChecks, ["first"]);
  await reopened.setTested("first", false);
  assert.deepEqual(reopened.getSnapshot().testedChecks, []);
});

test("overlapping saves retain both checks when responses arrive out of order", async () => {
  const pending: Array<(response: Response) => void> = [];
  const store = createManualTestStore("head", "/manual-tests", async (_url, options) => options?.method === "PUT"
    ? new Promise<Response>(resolve => pending.push(resolve)) : response([]));
  await store.load();
  const first = store.setTested("first", true), second = store.setTested("second", true);
  assert.deepEqual(store.getSnapshot().testedChecks, ["first", "second"]);
  pending[1](response(["first", "second"])); await second;
  pending[0](response(["first"])); await first;
  assert.deepEqual(store.getSnapshot().testedChecks, ["first", "second"]);
  assert.deepEqual(store.getSnapshot().pending, []);
});

test("a failed save rolls back only that check and reports the error", async () => {
  const store = createManualTestStore("head", "/manual-tests", async (_url, options) => options?.method === "PUT"
    ? Response.json({ error: "Could not save." }, { status: 400 }) : response(["first"]));
  await store.load(); await store.setTested("second", true);
  assert.deepEqual(store.getSnapshot().testedChecks, ["first"]);
  assert.equal(store.getSnapshot().error, "Could not save.");
});

test("load errors can be retried and stale heads cannot import completion", async () => {
  let attempt = 0;
  const store = createManualTestStore("head", "/manual-tests", async () => ++attempt === 1
    ? Response.json({ head: "old-head", testedChecks: ["first"] }) : response(["second"]));
  await store.load();
  assert.equal(store.getSnapshot().loaded, false);
  assert.match(store.getSnapshot().error ?? "", /review changed/);
  assert.deepEqual(store.getSnapshot().testedChecks, []);
  await store.load();
  assert.equal(store.getSnapshot().loaded, true);
  assert.deepEqual(store.getSnapshot().testedChecks, ["second"]);
});
