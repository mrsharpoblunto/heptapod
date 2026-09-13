import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { parseDifftasticOutput } from "@thestraylight/heptapod-core/semantic-diff";
import { DiffView, semanticDiffLayout, semanticDiffLines, semanticDiffSegments, semanticWholeLine } from "../src/web/ReviewViewer";
import fixtures from "./fixtures/difftastic-0.70.0.json";

// Captured from the reference native executable, including default and inline terminal
// output. Expected columns were checked against those outputs, not our renderer.
const layouts: Record<string, string[]> = {
  rename: ["both"], replace: ["both"], reflow: ["both"], unicode: ["both"], cpp: ["both"],
  wrap: ["after"], unwrap: ["before"], insert: ["after"], remove: ["before"],
  "block-add": ["after"], "block-remove": ["before"], new: ["after"], delete: ["before"],
  "separate-hunks": ["both", "after"],
};
for (const fixture of fixtures) test(`native Difftastic rendering: ${fixture.name}`, () => {
  const diff = parseDifftasticOutput(JSON.stringify(fixture.output), fixture.before, fixture.after);
  assert.equal(diff.status, "ready");
  if (diff.status !== "ready") return;
  const markup = renderToStaticMarkup(createElement(DiffView, { filePath: fixture.path,
    beforeContent: fixture.before, afterContent: fixture.after, semanticDiff: diff,
    patch: "@@ -1 +1 @@\n-old\n+new\n" }));
  if (fixture.name === "format") {
    assert.match(fixture.native, /No syntactic changes/);
    assert.match(markup, /No syntactic changes/);
    assert.doesNotMatch(markup, /data-diff-key|diff-token-change/);
    return;
  }
  const lines = semanticDiffLines(diff, fixture.before, fixture.after);
  assert.equal(lines.length, diff.alignment.length, "one rendered row per native aligned pair");
  assert.deepEqual(lines.map((line) => [line.old, line.next]), diff.alignment);
  const visible = semanticDiffSegments(lines).filter((segment) => segment.kind === "lines");
  assert.deepEqual(visible.map((segment) => semanticDiffLayout(segment.lines)), layouts[fixture.name], fixture.native);
  assert.doesNotMatch(markup, /diff-marker/, "structural columns do not masquerade as unified +/- lines");
  if (["wrap", "unwrap"].includes(fixture.name)) {
    assert.equal((markup.match(/data-diff-key=/g) ?? []).length, 1, "one-sided token changes show only one version");
    assert.doesNotMatch(markup, /diff-whole-line/);
  }
  if (["new", "delete", "block-add", "block-remove", "insert", "remove"].includes(fixture.name)) {
    assert.match(markup, /diff-whole-line/, "whole lines get full-column backgrounds");
  }
  if (["new", "delete"].includes(fixture.name)) {
    assert.equal((markup.match(/class="line-number"/g) ?? []).length, lines.length);
    assert.match(markup, /diff-single-gutter/);
    assert.doesNotMatch(markup, /class="line-number"><\/span>/);
  }
  if (fixture.name === "reflow") {
    assert.equal(lines.length, 4);
    assert.equal(lines[1].semantic?.after, "  1, 2");
    assert.deepEqual(lines[1].changes, [], "reflowed syntax stays unhighlighted");
  }
  if (fixture.name === "rename") {
    assert.equal((markup.match(/data-diff-key=/g) ?? []).length, 3);
    assert.equal((markup.match(/<mark /g) ?? []).length, 6);
    assert.doesNotMatch(markup, /diff-whole-line/);
  }
});

test("whole-line detection includes indentation and blank added lines, but excludes partial replacements", () => {
  assert.equal(semanticWholeLine("  work();", [{ start: 2, end: 9 }], null), true);
  assert.equal(semanticWholeLine("", [], null), true);
  assert.equal(semanticWholeLine("", [], ""), false);
  assert.equal(semanticWholeLine(null, [], ""), false);
  assert.equal(semanticWholeLine("work();", [{ start: 0, end: 4 }], "save();"), false);
});
