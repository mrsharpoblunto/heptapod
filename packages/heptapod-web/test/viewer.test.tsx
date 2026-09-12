import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import type { RenderModel } from "@thestraylight/heptapod/types";
import { ReviewIndex } from "../src/web/ReviewIndex.js";
import { buildDiffSegments, parseDiff, ReviewViewer } from "../src/web/ReviewViewer.js";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

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
  assert.match(markup, /Introduce bounded arithmetic/);
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

test("renders ingestion instructions and linked pull-request metadata on the index", () => {
  const markup = renderToStaticMarkup(createElement(ReviewIndex, { reviews: [{
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
  assert.match(markup, /heptapod capture --pr/);
  assert.match(markup, /progress-spinner/);
  assert.match(markup, /https:\/\/github.com\/example\/math\/pull\/42/);
  assert.match(markup, new RegExp(`https://github.com/example/math/commit/${base}`));
  assert.match(markup, /Sep 11, 2026/);
});
