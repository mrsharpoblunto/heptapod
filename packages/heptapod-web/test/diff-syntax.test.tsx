import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { highlightSourceLines, SyntaxCode } from "../src/web/DiffSyntax";
import { DiffView } from "../src/web/ReviewViewer";

test("changed words and unchanged tails retain the comment scope", () => {
  const content = "// The largest move one transport pass may make. Above one whole cell the upwind blend starts being a smear.";
  const start = content.indexOf("transport"), end = start + "transport".length;
  const syntax = highlightSourceLines(content, "typescript")[0];
  const markup = renderToStaticMarkup(createElement(SyntaxCode, { content, changes: [{ start, end }], syntax }));
  assert.match(markup, /<mark class="diff-token-change"><span class="hljs-comment">transport<\/span><\/mark>/);
  assert.match(markup, /<span class="hljs-comment"> pass may make/);
  assert.ok(syntax.every((run) => run.scopes.includes("hljs-comment")));
});

test("multiline comments and strings retain their scope in both revisions and snippets", () => {
  const before = '/* description\n * old value\n */\nconst message = `first\nsecond`;\n';
  const after = before.replace("old value", "new value");
  const syntax = highlightSourceLines(after, "typescript");
  assert.ok(syntax[1].every((run) => run.scopes.includes("hljs-comment")));
  assert.ok(syntax[4].some((run) => run.scopes.includes("hljs-string")));
  const props = { filePath: "comment.ts", beforeContent: before, afterContent: after,
    patch: "@@ -2 +2 @@\n- * old value\n+ * new value\n",
    semanticDiff: { status: "ready" as const, language: "TypeScript", unchanged: false,
      alignment: [[1,1], [2,2], [3,3], [4,4], [5,5]] as Array<[number,number]>,
      before: { 2: [{ start: 3, end: 6 }] }, after: { 2: [{ start: 3, end: 6 }] } } };
  for (const extra of [{}, { snippetRange: { side: "LEFT" as const, startLine: 2, endLine: 2 } }, { semanticDiff: undefined }]) {
    const markup = renderToStaticMarkup(createElement(DiffView, { ...props, ...extra }));
    assert.match(markup, /class="hljs-comment"/);
    assert.doesNotMatch(markup, /hljs-keyword[^>]*>new/);
  }
});

test("entity decoding preserves source offsets and React escapes source text", () => {
  const content = '// 😀 <script> "quotes" &amp; \'apostrophe\' & tail';
  const syntax = highlightSourceLines(content, "typescript")[0];
  const start = content.indexOf("tail");
  const markup = renderToStaticMarkup(createElement(SyntaxCode, { content, syntax, changes: [{ start, end: start + 4 }] }));
  assert.equal(syntax.at(-1)?.end, content.length);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&amp;amp;/);
  assert.match(markup, /<mark class="diff-token-change"><span class="hljs-comment">tail<\/span><\/mark>/);
  assert.doesNotMatch(markup, /<script>/);
});
