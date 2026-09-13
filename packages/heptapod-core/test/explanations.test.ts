import assert from "node:assert/strict";
import { test } from "vitest";
import { assertStepExplanations } from "../src/tool/explanations.js";
import { splitPatchFiles } from "../src/tool/patch.js";
import type { DiffExplanation, NarrativeStep } from "../src/tool/types.js";

const patch = "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -10,3 +10,4 @@\n keep();\n-old();\n+first();\n+second();\n end();\n";
const files = splitPatchFiles(patch);
const note: DiffExplanation = { file: "new.ts", side: "RIGHT", startLine: 11, endLine: 12, text: "Keep these operations ordered so the second can use the first result." };
const step = (explanations?: DiffExplanation[]): NarrativeStep => ({ id: "change", title: "Change", kind: "implementation", diff: "step.diff", checks: { automated: [], manual: [] }, explanations });

test("explanations are optional and accept exact before/after source ranges, including context", () => {
  for (const notes of [undefined, [], [note], [{ ...note, side: "LEFT" as const, startLine: 10, endLine: 12 }], [{ ...note, endLine: undefined }]]) {
    assert.doesNotThrow(() => assertStepExplanations(step(notes), files, new Set()));
  }
});

test("rejects invalid shapes, stale anchors, wrong sides, and files outside the step", () => {
  for (const invalid of [null, {}, "note", [null], [{ ...note, file: "old.ts" }], [{ ...note, file: "other.ts" }],
    [{ ...note, side: "after" }], [{ ...note, startLine: 0 }], [{ ...note, startLine: 1.5 }], [{ ...note, endLine: 10 }],
    [{ ...note, endLine: null }], [{ ...note, endLine: 14 }], [{ ...note, side: "LEFT", endLine: 13 }],
    [{ ...note, text: " " }], [{ ...note, text: "x".repeat(2001) }]]) {
    assert.throws(() => assertStepExplanations(step(invalid as DiffExplanation[]), files, new Set()), /Invalid narrative: step change explanations/);
  }
  assert.throws(() => assertStepExplanations(step([note]), files, new Set(["new.ts"])), /generated/);
  assert.throws(() => assertStepExplanations(step([note]), [], new Set()), /this step's diff/);
});

test("ranges cannot cross omitted context or annotate binary/pure-move patches", () => {
  const separated = splitPatchFiles(patch + "@@ -20 +21 @@\n-last();\n+next();\n");
  assert.throws(() => assertStepExplanations(step([{ ...note, endLine: 21 }]), separated, new Set()), /must be present/);
  const binary = [{ ...files[0], patch: "GIT binary patch\nliteral 4\nabc\n" }];
  assert.throws(() => assertStepExplanations(step([note]), binary, new Set()), /binary/);
  const moved = [{ ...files[0], patch: "rename from old.ts\nrename to new.ts\n" }];
  assert.throws(() => assertStepExplanations(step([note]), moved, new Set()), /must be present/);
});
