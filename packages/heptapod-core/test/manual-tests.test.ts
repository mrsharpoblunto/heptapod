import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { accumulatedManualTests, manualTestId } from "../src/tool/manual-tests.js";
import { beginReviewUpdate, deleteReview, getManualTestState, setManualTestResult, upsertReview } from "../src/tool/database.js";
import type { Check, RenderModel, RenderStep } from "../src/tool/types.js";

const first: Check = { label: "Open the dialog", detail: "Check the controls.", status: "not-run", basis: "expected" };
const second: Check = { ...first, label: "Resize the dialog" };
const steps: RenderStep[] = [[], [first], [first, second], []].map((manual, index) => ({
  id: `step-${index}`, number: index + 1, title: `Step ${index}`, kind: "manual", body: "", patch: "",
  fileDiffs: [], stats: { additions: 0, deletions: 0, files: 0 }, checks: { automated: [], manual },
}));
const model: RenderModel = { title: "Review", summary: "", steps,
  source: { base: "base", head: "head", diff: "source.diff", files: [], stats: { additions: 0, deletions: 0, files: 0 } },
  verification: { base: "base", head: "head", tree: "tree", exact: true, sourceBytes: 0, patchSteps: 0 },
};
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function database() {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-manual-tests-")); directories.push(directory);
  const path = join(directory, "reviews.sqlite"); upsertReview("71", model, path); return path;
}

test("manual checks accumulate only after introduction and repeated checks share an identity", () => {
  assert.deepEqual(accumulatedManualTests(steps, 0), []);
  assert.deepEqual(accumulatedManualTests(steps, 1).map(test => test.check.label), [first.label]);
  const final = accumulatedManualTests(steps, 3);
  assert.deepEqual(final.map(test => test.check.label), [first.label, second.label]);
  assert.equal(final[0].stepId, "step-1");
  assert.equal(manualTestId({ ...first, status: "passing", basis: "observed" }), manualTestId(first));
  assert.notEqual(manualTestId({ ...first, detail: "Check a different procedure." }), manualTestId(first));
});

test("manual completion persists, can be undone, and is isolated by review", () => {
  const path = database();
  assert.deepEqual(getManualTestState("71", path), { head: "head", testedChecks: [] });
  setManualTestResult("71", "head", manualTestId(first), true, path);
  setManualTestResult("71", "head", manualTestId(second), true, path);
  assert.equal(getManualTestState("71", path).testedChecks.length, 2);
  setManualTestResult("71", "head", manualTestId(first), false, path);
  assert.deepEqual(getManualTestState("71", path).testedChecks, [manualTestId(second)]);
  upsertReview("72", model, path);
  assert.deepEqual(getManualTestState("72", path).testedChecks, []);
  deleteReview("71", path);
  upsertReview("71", model, path);
  assert.deepEqual(getManualTestState("71", path).testedChecks, []);
});

test("refreshes preserve completion at the same head and reject stale or unknown checks", () => {
  const path = database();
  setManualTestResult("71", "head", manualTestId(first), true, path);
  upsertReview("71", model, path);
  assert.deepEqual(getManualTestState("71", path).testedChecks, [manualTestId(first)]);
  assert.throws(() => setManualTestResult("71", "head", "unknown", true, path), /not found/);
  assert.throws(() => setManualTestResult("71", "head", manualTestId(first), "yes" as unknown as boolean, path), /Invalid/);
  beginReviewUpdate("71", path);
  assert.throws(() => setManualTestResult("71", "head", manualTestId(first), false, path), /finish loading/);
  upsertReview("71", { ...model, source: { ...model.source, head: "new-head" } }, path);
  assert.deepEqual(getManualTestState("71", path).testedChecks, []);
  assert.throws(() => setManualTestResult("71", "head", manualTestId(first), true, path), /review changed/);
});
