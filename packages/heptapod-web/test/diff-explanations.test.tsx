import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import type { DiffExplanation, RenderStep, SemanticDiff } from "@thestraylight/heptapod-core/types";
import { DiffView, resolveStepFile, semanticDiffLines, semanticDiffSegments } from "../src/web/ReviewViewer";
import { ExplanationText } from "../src/web/DiffExplanationBubble";

const before = "const total = price + tax;\n", after = "const total = round(price + tax);\n";
const semanticDiff: SemanticDiff = { status: "ready", language: "TypeScript", unchanged: false,
  alignment: [[1,1]], before: { 1: [] }, after: { 1: [{ start: 14, end: 20 }, { start: 31, end: 32 }] } };
const note: DiffExplanation = { file: "total.ts", side: "RIGHT", startLine: 1, text: "Round the combined value once to avoid accumulating rounding errors." };
const props = { filePath: "total.ts", patch: "@@ -1 +1 @@\n-const total = price + tax;\n+const total = round(price + tax);\n", beforeContent: before, afterContent: after };
const render = (extra: Partial<Parameters<typeof DiffView>[0]>) => renderToStaticMarkup(createElement(DiffView, { ...props, ...extra }));

test("explanation links are clickable HTTP references while other text stays escaped", () => {
  const markup = renderToStaticMarkup(createElement(ExplanationText, { text:
    "See [related PR](https://github.com/example/project/pull/12) and [API](https://example.com/api(method)#usage). " +
    "[unsafe](javascript:alert(1)) [data](data:text/html,hello) [local](file:///tmp/code) " +
    "`[literal](https://example.com)` <script>alert(1)</script>" }));
  assert.equal((markup.match(/<a /g) ?? []).length, 2);
  assert.match(markup, /href="https:\/\/github.com\/example\/project\/pull\/12" target="_blank" rel="noopener noreferrer">related PR<\/a>/);
  assert.match(markup, /href="https:\/\/example.com\/api\(method\)#usage"/);
  assert.doesNotMatch(markup, /<script>|href="(?:javascript:|data:|file:)/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markup, /`\[literal\]\(https:\/\/example.com\)`/);
});

test("explanations render in structural and standard diffs, including compact snippets", () => {
  for (const extra of [{}, { compact: true }, { snippetRange: { side: "RIGHT" as const, startLine: 1, endLine: 1 } }]) {
    for (const diff of [undefined, semanticDiff]) {
      const markup = render({ ...extra, semanticDiff: diff, explanations: [note] });
      assert.equal((markup.match(/class="diff-explanation-bubble"/g) ?? []).length, 1);
      assert.match(markup, /Explanation: updated line 1/);
      assert.match(markup, /aria-expanded="false"/);
      assert.doesNotMatch(markup, /Round the combined/, "popup prose is revealed on interaction");
    }
  }
  assert.doesNotMatch(render({ semanticDiff }), /diff-explanation-bubble|diff-with-explanations/);
  assert.doesNotMatch(render({ explanations: [{ ...note, file: "other.ts" }] }), /diff-explanation-bubble/);
});

test("multiple explanations on one aligned row share a bubble and expose the referenced side", () => {
  const markup = render({ semanticDiff, explanations: [note, { ...note, side: "LEFT", text: "The previous calculation did not round." }] });
  assert.equal((markup.match(/class="diff-explanation-bubble"/g) ?? []).length, 1);
  assert.match(markup, /2 explanations for this line/);
  assert.match(markup, /diff-split-row/);
});

test("explanations reveal annotated structural context and do not carry into later snapshots", () => {
  const source = Array.from({ length: 30 }, (_, index) => `keep${index}();`).join("\n");
  const diff: Extract<SemanticDiff, {status:"ready"}> = { status: "ready", language: "TypeScript", unchanged: false,
    alignment: Array.from({length:30}, (_,i)=>[i+1,i+1]), before: {1:[{start:0,end:4}]}, after:{1:[{start:0,end:4}]} };
  const range = { ...note, startLine: 20, endLine: 22 };
  const segments = semanticDiffSegments(semanticDiffLines(diff, source, source), [range]);
  for (const line of [20,21,22]) assert.ok(segments.some(segment=>segment.kind==="lines" && segment.lines.some(row=>row.next===line)));
  const step = { id:"one",fileDiffs:[{path:"total.ts",...props,semanticDiff,explanations:[note]}] } as unknown as RenderStep;
  const next = { ...step, id:"two",fileDiffs:[] };
  assert.deepEqual(resolveStepFile([step],0,"total.ts")?.explanations,[note]);
  assert.equal(resolveStepFile([step,next],1,"total.ts")?.explanations,undefined);
});

test("original-side explanations work for deletions and syntax-unchanged diffs retain bubbles", () => {
  const deleted = render({ patch:"deleted file mode 100644\n@@ -1 +0,0 @@\n-const total = price + tax;\n", afterContent:null,
    explanations:[{...note,side:"LEFT"}] });
  assert.match(deleted, /Explanation: original line 1/);
  const unchanged = render({ semanticDiff: {...semanticDiff,unchanged:true}, explanations:[note] });
  assert.match(unchanged,/Explanation: updated line 1/);
});

test("bubbles anchor to source line numbers rather than diff row positions", () => {
  const oldSource = Array.from({ length: 10 }, (_, i) => `old${i + 1}();`).join("\n");
  const newSource = Array.from({ length: 13 }, (_, i) => `new${i + 1}();`).join("\n");
  const oldNote = { ...note, side: "LEFT" as const, startLine: 9 };
  const newNote = { ...note, startLine: 13 };
  const diff: SemanticDiff = { status: "ready", language: "TypeScript", unchanged: false,
    alignment: [[8, 11], [9, 12], [10, 13]],
    before: { 9: [{ start: 0, end: 4 }] }, after: { 12: [{ start: 0, end: 5 }] } };
  const patch = "@@ -8,3 +11,3 @@\n old8();\n-old9();\n+new12();\n old10();\n";
  for (const semanticDiff of [undefined, diff]) {
    const markup = render({ patch, beforeContent: oldSource, afterContent: newSource,
      semanticDiff, explanations: [oldNote, newNote] });
    const rows = markup.match(/<div class="diff-line [\s\S]*?<\/div>/g) ?? [];
    const oldRow = rows.find(row => row.includes('aria-label="Explanation: original line 9"'));
    const newRow = rows.find(row => row.includes('aria-label="Explanation: updated line 13"'));
    assert.ok(oldRow);
    assert.ok(newRow);
    assert.match(oldRow, /data-old-line="9"/);
    assert.match(newRow, /data-new-line="13"/);
    assert.doesNotMatch(oldRow, /data-new-line="13"/);
    assert.doesNotMatch(newRow, /data-old-line="9"/);
  }
});
