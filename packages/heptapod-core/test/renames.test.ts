import assert from "node:assert/strict";
import { test } from "vitest";
import { patchRename, splitPatchFiles } from "../src/tool/patch.js";

test("rename paths preserve prefixes, spaces, and Git-quoted Unicode", () => {
  const patch = 'diff --git a/a/old name.ts b/b/new name.ts\nsimilarity index 100%\nrename from a/old name.ts\nrename to b/new name.ts\n';
  assert.deepEqual(patchRename(patch), { from: "a/old name.ts", to: "b/new name.ts" });
  assert.deepEqual(splitPatchFiles(patch), [{ path: "b/new name.ts", from: "a/old name.ts", patch }]);
  assert.deepEqual(patchRename(String.raw`rename from "a/caf\303\251.ts"
rename to "b/caf\303\251.ts"
`), { from: "a/café.ts", to: "b/café.ts" });
  assert.equal(patchRename("diff --git a/file b/file\n@@ -1 +1 @@\n rename from old\n rename to new\n"), null);
});
