import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import type { RenderModel, ReviewComment } from "@thestraylight/heptapod/types";
import { ReviewIndex } from "../src/web/ReviewIndex.js";
import { PendingReview } from "../src/web/PendingReview.js";
import RootLayout from "../app/layout";
import { buildDiffSegments, DiffView, newestFixtureRuns, parseDiff, resolveStepFile, reviewRailItems, ReviewViewer } from "../src/web/ReviewViewer.js";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/reviews/42" }));

const base = "1111111111111111111111111111111111111111";
const head = "2222222222222222222222222222222222222222";

const data: RenderModel = {
  title: "Introduce bounded arithmetic",
  summary: "Specify clamping, implement it, and update the app.",
  source: {
    base,
    head,
    diff: "source.diff",
    files: [{ status: "M", path: "src/math.js" }],
    github: {
      pullRequestUrl: "https://github.com/example/math/pull/42",
      repositoryUrl: "https://github.com/example/math",
      number: 42,
    },
    stats: { additions: 1, deletions: 0, files: 1 },
  },
  verification: {
    base,
    head,
    tree: "3333333333333333333333333333333333333333",
    sourceBytes: 120,
    patchSteps: 1,
    exact: true,
  },
  steps: [{
    id: "context",
    number: 1,
    title: "Bound arithmetic results",
    kind: "description",
    body: "Start with [`math.js`](heptapod-file:src%2Fmath.js).\n\n```js\nconst bounded = true;\n```",
    patch: "",
    fileDiffs: [],
    referenceFiles: [{ path: "src/math.js", patch: "", beforeContent: "export const add = () => 0;\n", afterContent: "export const add = () => 0;\n" }],
    checks: { automated: [], manual: [] },
    testRun: {
      command: "pnpm test",
      scope: "full-suite",
      files: [],
      status: "failing",
      expectedStatus: "passing",
      expectationMatched: false,
      exitCode: 1,
      durationMs: 42,
      expectedFailures: [],
      observedFailures: ["clamps the value"],
      unexpectedFailures: ["clamps the value"],
      fixtureRuns: [{
        file: "src/math.test.js",
        command: "pnpm test src/math.test.js",
        status: "failing",
        expectedStatus: "passing",
        expectationMatched: false,
        exitCode: 1,
        durationMs: 42,
        observedFailures: ["clamps the value"],
        unexpectedFailures: ["clamps the value"],
        output: "FAIL clamps the value",
      }],
      output: "FAIL clamps the value",
    },
    stats: { additions: 0, deletions: 0, files: 0 },
  }],
};

test("renders the packaged viewer around shared core model types", () => {
  const markup = renderToStaticMarkup(createElement(ReviewViewer, {
    data,
    reviewId: "42",
    updatedAt: "2026-09-11T12:00:00.000Z",
  }));
  assert.match(markup, /<strong class="review-title">Introduce bounded arithmetic<\/strong>/);
  assert.match(markup, /class="review-back-link"[^>]*href="\/"/);
  assert.match(markup, /aria-label="Back to reviews"/);
  assert.match(markup, /Sep 11, 2026/);
  assert.match(markup, /PR #42/);
  assert.match(markup, new RegExp(`https://github.com/example/math/commit/${base}`));
  assert.doesNotMatch(markup, /Exact reconstruction/);
  assert.doesNotMatch(markup, />Narrative</);
  assert.doesNotMatch(markup, />1 steps</);
  assert.doesNotMatch(markup, /Collapse step navigation/);
  assert.match(markup, /Collapse details panel/);
  assert.match(markup, /Resize details panel/);
  assert.match(markup, />Step summary</);
  assert.match(markup, /Previous step/);
  assert.match(markup, /Next step/);
  assert.match(markup, /file-link-inline/);
  assert.match(markup, />math\.js</);
  assert.match(markup, /hljs-keyword/);
  assert.doesNotMatch(markup, /Observed test run/);
  assert.match(markup, />Tests</);
  assert.match(markup, />0\/1 passing</);
  assert.match(markup, /Show test output for src\/math.test.js/);
  assert.match(markup, /Open src\/math.test.js in diff/);
  assert.match(markup, /src\/math.test.js/);
  assert.match(markup, /1 full-suite failure/);
  assert.doesNotMatch(markup, />Expected</);
  assert.doesNotMatch(markup, />Unexpected</);
  assert.match(markup, /Test output/);
  assert.doesNotMatch(markup, /Full suite · pnpm test/);
  assert.doesNotMatch(markup, /Changed test fixtures/);
  assert.doesNotMatch(markup, /Full test suite/);
  assert.match(markup, /Add review comment/);
  assert.doesNotMatch(markup, /Comment on this step/);
  assert.match(markup, /Prepare GitHub draft/);
});

test("does not mount the homepage canvas when rendering completed reviews directly", () => {
  const ready = createElement(ReviewViewer, { data, reviewId: "42", updatedAt: "2026-09-11T12:00:00.000Z" });
  const markup = renderToStaticMarkup(createElement(RootLayout, { children: ready }));
  assert.doesNotMatch(markup, /<canvas|heptapod-backdrop/);
  assert.match(markup, /<main/);
});

test("mounts the homepage canvas while waiting for a review", () => {
  const pending = createElement(PendingReview, { id: "42", title: data.title, status: "pending", progress: "Preparing review", error: null });
  const markup = renderToStaticMarkup(createElement(RootLayout, { children: pending }));
  assert.match(markup, /<canvas[^>]*heptapod-backdrop/);
  assert.match(markup, /Preparing review/);
});

test("hides review and annotation controls for revision comparisons", () => {
  const markup = renderToStaticMarkup(createElement(ReviewViewer, {
    data: { ...data, source: { ...data.source, github: undefined } },
    reviewId: `${base}/${head}`,
    updatedAt: "2026-09-11T12:00:00.000Z",
  }));
  assert.doesNotMatch(markup, /Comment on this step|Prepare GitHub draft|comment-anchor|Publish draft comments|Comment on updated line/);
});

test("builds expandable context gaps around minimal diff hunks", () => {
  const patch = [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -3,1 +3,1 @@",
    "-old value",
    "+new value",
    "",
  ].join("\n");
  const segments = buildDiffSegments(
    parseDiff(patch).slice(3),
    "one\ntwo\nold value\nfour\nfive\n",
    "one\ntwo\nnew value\nfour\nfive\n",
  );
  const gaps = segments.filter((segment) => segment.kind === "gap");
  assert.deepEqual(gaps.map((segment) => segment.gap.lines.length), [2, 2]);
  assert.equal(gaps[0].gap.lines[0].content, " one");
  assert.equal(gaps[1].gap.lines[1].content, " five");
});

test("an updating review keeps its content and shows status before header metadata", () => {
  const markup = renderToStaticMarkup(createElement(ReviewViewer, {
    data, reviewId: "42", updatedAt: "2026-09-11T12:00:00.000Z", updating: true,
  }));
  assert.match(markup, /class="review-updating" role="status"/);
  assert.match(markup, /Updating…/);
  assert.ok(markup.indexOf("review-updating") < markup.indexOf('class="github-link"'));
  assert.match(markup, /Bound arithmetic results/);
  assert.match(markup, /Start with/);
});

test("opens a previously changed test as its latest full content at the selected step", () => {
  const path = "src/math.test.js";
  const original = "it('clamps values', () => expect(clamp(12)).toBe(10));\n";
  const latest = "describe('bounds', () => {\n  it('clamps values', () => expect(clamp(15)).toBe(10));\n});\n";
  const unchanged = { ...data.steps[0], fileDiffs: [], referenceFiles: [] };
  const steps = [
    { ...unchanged, fileDiffs: [{ path, patch: "+original test", beforeContent: null, afterContent: original }] },
    { ...unchanged, fileDiffs: [{ path, patch: "-original test\n+updated test", beforeContent: original, afterContent: latest }] },
    unchanged,
    { ...unchanged, fileDiffs: [{ path, patch: "+future test", beforeContent: latest, afterContent: "future content\n" }] },
  ];
  const file = resolveStepFile(steps, 2, steps[2].testRun!.fixtureRuns[0].file);
  assert.ok(file);
  assert.equal(file.beforeContent, latest);
  assert.equal(file.afterContent, latest);
  assert.equal(file.patch, "");
  const lines = buildDiffSegments(parseDiff(file.patch), file.beforeContent, file.afterContent)
    .flatMap((segment) => segment.kind === "lines" ? segment.lines : []);
  assert.equal(lines.map((line) => line.content.slice(1)).join("\n") + "\n", latest);
  assert.ok(lines.every((line) => line.type === "context"));
  assert.deepEqual(lines.map((line) => [line.old, line.next]), [[1, 1], [2, 2], [3, 3]]);
});

test("preserves current-step diffs and reference snapshots when opening a test", () => {
  const file = { path: "src/math.test.js", patch: "+changed test", beforeContent: "old\n", afterContent: "new\n" };
  const changed = { ...data.steps[0], fileDiffs: [file], referenceFiles: [] };
  const reference = { ...file, patch: "", beforeContent: "reference\n", afterContent: "reference\n" };
  const referenced = { ...changed, fileDiffs: [], referenceFiles: [reference] };
  assert.equal(resolveStepFile([changed, referenced], 0, file.path), file);
  assert.equal(resolveStepFile([changed, referenced], 1, file.path), reference);
  assert.equal(resolveStepFile([changed], 0, null), undefined);
});

test("does not open future tests or revive deleted or unavailable test content", () => {
  const path = "src/math.test.js";
  const unchanged = { ...data.steps[0], fileDiffs: [], referenceFiles: [] };
  const added = { ...unchanged, fileDiffs: [{ path, patch: "+test", beforeContent: null, afterContent: "test\n" }] };
  const removed = { ...unchanged, fileDiffs: [{ path, patch: "-test", beforeContent: "test\n", afterContent: null }] };
  const steps = [unchanged, added, removed, unchanged, added];
  assert.equal(resolveStepFile(steps, 0, path), undefined);
  assert.equal(resolveStepFile(steps, 2, path), removed.fileDiffs[0]);
  assert.equal(resolveStepFile(steps, 3, path), undefined);
  assert.equal(resolveStepFile(steps, 4, path), added.fileDiffs[0]);
  assert.equal(resolveStepFile([added, { ...unchanged, fileDiffs: [{ path, patch: "+unknown" }] }, unchanged], 2, path), undefined);
});

test("renders ingestion instructions and linked pull-request metadata on the index", () => {
  const markup = renderToStaticMarkup(createElement(ReviewIndex, { repository: { name: "example/math", githubUrl: "https://github.com/example/math" }, reviews: [{
    id: "42",
    title: "Introduce bounded arithmetic",
    summary: "Specify clamping, implement it, and update the app.",
    sourceUrl: "https://github.com/example/math/pull/42",
    baseRevision: base,
    headRevision: head,
    updatedAt: "2026-09-11T12:00:00.000Z",
    status: "pending" as const,
    progress: "Running tests after step 2/4",
    error: null,
    additions: 1,
    deletions: 0,
  }] }));
  assert.match(markup, /<h1[^>]*>HEPTAPOD<\/h1>/);
  assert.match(markup, /Connected repository: <a href="https:\/\/github.com\/example\/math"/);
  assert.doesNotMatch(markup, /Run Heptapod from the repository/);
  assert.match(markup, /Use the installed agent skill/);
  assert.match(markup, /<canvas[^>]*heptapod-backdrop/);
  assert.match(markup, /heptapod capture --pr/);
  assert.match(markup, /gh auth login/);
  assert.match(markup, /gh auth status/);
  assert.match(markup, /progress-spinner/);
  assert.match(markup, /https:\/\/github.com\/example\/math\/pull\/42/);
  assert.match(markup, new RegExp(`https://github.com/example/math/commit/${base}`));
  assert.match(markup, /Sep 11, 2026/);
});

test("implementation groups expand every critical diff and list secondary descriptions and statuses", () => {
  const files = ["logic.ts", "bounds.ts", "setup.ts"];
  const step: RenderModel["steps"][number] = {
    id: "behavior", title: "Bound retries", kind: "implementation", number: 1, body: "", patch: "",
    checks: { automated: [], manual: [] }, stats: { additions: 3, deletions: 0, files: 3 },
    fileDiffs: files.map((path, index) => ({ path, patch: `@@ -0,0 +1 @@\n+unique_${index}\n`, beforeContent: null, afterContent: `unique_${index}\n` })),
    sections: [{
      name: "Retry decisions", priority: "critical", description: "Enforces **retry bounds**.",
      files: [{ label: "Retry loop", file: files[0] }, { label: "Attempt limit", file: files[1] }],
    }, {
      name: "Registration", priority: "secondary", description: "Registers the behavior without changing the algorithm.",
      files: [{ label: "Register retry policy", file: files[2] }],
    }],
  };
  const markup = renderToStaticMarkup(createElement(ReviewViewer, { data: { ...data, steps: [step] }, reviewId: "42", updatedAt: "2026-09-11T12:00:00.000Z" }));
  assert.match(markup, /test-type-badge critical-badge">Critical</);
  assert.match(markup, /test-type-badge">Secondary</);
  assert.match(markup, /<strong>retry bounds<\/strong>/);
  for (const file of files.slice(0, 2)) assert.ok(markup.includes(`aria-expanded="true" aria-label="Collapse ${file} diff"`));
  assert.match(markup, /unique_0/);
  assert.match(markup, /unique_1/);
  assert.doesNotMatch(markup, /unique_2|Collapse setup\.ts diff/);
  assert.match(markup, /connected-file-list/);
  assert.match(markup, /Register retry policy/);
  assert.match(markup, /setup\.ts/);
  assert.match(markup, /file-link test-case-added/);
});


test("unchanged source uses one line-number column while changed source retains both", () => {
  const unchanged = renderToStaticMarkup(createElement(DiffView, {
    filePath: "reference.ts", patch: "@@ -1,2 +1,2 @@\n first\n second\n",
    beforeContent: "first\nsecond\n", afterContent: "first\nsecond\n", compact: true,
  }));
  assert.match(unchanged, /diff-compact diff-pure/);
  assert.equal(unchanged.match(/class="line-number"/g)?.length, 2);
  const changed = renderToStaticMarkup(createElement(DiffView, {
    filePath: "changed.ts", patch: "@@ -1 +1 @@\n-old\n+new\n",
    beforeContent: "old\n", afterContent: "new\n", compact: true,
  }));
  assert.doesNotMatch(changed, /diff-pure/);
  assert.equal(changed.match(/class="line-number"/g)?.length, 4);
});


test("newly introduced fixtures precede older coverage without changing their relative order", () => {
  const run = data.steps[0].testRun!;
  const fixture = run.fixtureRuns[0];
  const step = (files: string[]): RenderModel["steps"][number] => ({
    ...data.steps[0], testRun: { ...run, fixtureRuns: files.map((file) => ({ ...fixture, file })) },
  });
  const steps = [step(["old-a.ts", "old-b.ts"]), step(["old-a.ts", "old-b.ts", "new-a.ts", "new-b.ts"]), step(["old-a.ts", "old-b.ts", "new-a.ts", "new-b.ts", "latest.ts"])];
  assert.deepEqual(newestFixtureRuns(steps, 1).map((run) => run.file), ["new-a.ts", "new-b.ts", "old-a.ts", "old-b.ts"]);
  assert.deepEqual(newestFixtureRuns(steps, 2).map((run) => run.file), ["latest.ts", "new-a.ts", "new-b.ts", "old-a.ts", "old-b.ts"]);
  assert.deepEqual(steps[2].testRun!.fixtureRuns.map((run) => run.file), ["old-a.ts", "old-b.ts", "new-a.ts", "new-b.ts", "latest.ts"]);
});


test("counts review rail files and tests once and opens their latest changed snapshots", () => {
  const testCase = { name: "clamps values", change: "added" as const, newLine: 2, newEndLine: 4 };
  const first = { ...data.steps[0], id: "first", fileDiffs: [{ path: "src/math.js", patch: "" }], testAreas: [{ name: "Bounds", description: "", files: [{ path: "src/math.test.js", cases: [testCase] }] }] };
  const last = { ...first, id: "last", testAreas: [{ ...first.testAreas[0], files: [{ path: "src/math.test.js", cases: [{ ...testCase, newLine: 5, newEndLine: 7 }] }] }] };
  const comments: ReviewComment[] = [
    { id: "file", body: "File question", target: { kind: "file", stepId: "first", anchor: "file", path: "src/math.js" } },
    { id: "line", body: "Line question", target: { kind: "line", stepId: "last", anchor: "code", path: "src/math.js", side: "RIGHT", startLine: 1, endLine: 1 } },
    { id: "empty", body: "", target: { kind: "file", stepId: "last", anchor: "empty", path: "src/empty.js" } },
    { id: "summary", body: "Overall question", target: { kind: "section", stepId: "last", anchor: "body", section: "Summary" } },
  ];
  const items = reviewRailItems({ ...data, steps: [first, last] }, comments);
  assert.deepEqual(items.commentedFiles, [{ path: "src/math.js", stepId: "last" }]);
  assert.equal(items.changedTests.length, 1);
  assert.equal(items.changedTests[0].stepId, "last");
  assert.equal(items.changedTests[0].testCase.newLine, 5);
  assert.equal(items.changedFiles.length, 1);
  assert.equal(items.changedFiles[0].stepId, "last");
});
