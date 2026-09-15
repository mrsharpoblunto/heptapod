import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
vi.mock("../src/tool/generated-files.js", () => ({ generatedFiles: () => new Set<string>() }));
import { getReview } from "../src/tool/database.js";
import { ingestNarrative } from "../src/tool/ingest.js";
import { loadManifest } from "../src/tool/manifest.js";
import { buildReviewModel } from "../src/tool/model.js";
import type { NarrativeManifest, NarrativeStep, VerificationResult } from "../src/tool/types.js";

const verification: VerificationResult = { base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40), sourceBytes: 0, patchSteps: 1, exact: true };
const patch = [
  "diff --git a/logic.ts b/logic.ts\n--- a/logic.ts\n+++ b/logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
  "diff --git a/setup.ts b/setup.ts\nnew file mode 100644\n--- /dev/null\n+++ b/setup.ts\n@@ -0,0 +1 @@\n+setup\n",
].join("");

function fixture(kind: "tests" | "implementation" | "refactor") {
  const root = mkdtempSync(join(tmpdir(), "heptapod-file-coverage-"));
  writeFileSync(join(root, "step.diff"), patch);
  writeFileSync(join(root, "context.md"), "Context");
  const step: NarrativeStep = { id: "change", title: "Change behavior", kind, diff: "step.diff", checks: { automated: [], manual: [] } };
  if (kind === "tests") step.cases = [{ name: "Behavior", description: "Exercises behavior and supporting setup", files: ["logic.ts"] }];
  if (kind === "refactor") step.interfaces = [{ name: "Behavior", file: "logic.ts", callsites: [{ label: "Shared implementation", file: "logic.ts" }] }];
  if (kind === "implementation") step.sections = [{ name: "Behavior", description: "Owns the behavior", priority: "critical", files: [{ label: "Logic", file: "logic.ts" }] }];
  const manifest: NarrativeManifest = {
    schemaVersion: 1, title: "Change", summary: "Change behavior", source: { base: verification.base, head: verification.head, diff: "step.diff" },
    steps: [{ id: "context", title: "Context", kind: "description", body: "context.md", checks: { automated: [], manual: [] } }, step],
  };
  const manifestPath = join(root, "narrative.json");
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  const include = (file: string) => {
    if (kind === "tests") step.cases![0].files.push(file);
    if (kind === "refactor") step.interfaces![0].callsites.push({ label: "Supporting setup", file });
    if (kind === "implementation") step.sections!.push({ name: "Setup", description: "Registers the behavior without changing its logic", priority: "secondary", files: [{ label: "Supporting setup", file }] });
  };
  save();
  return { root, step, manifest, manifestPath, save, include };
}

for (const kind of ["tests", "implementation", "refactor"] as const) {
  test(`${kind}: omitted diff files reject validation, rendering, and ingestion`, () => {
    const { root, manifest, manifestPath } = fixture(kind);
    const error = /Step change .*does not account for 1 file\(s\).*\n- setup\.ts/;
    assert.throws(() => loadManifest(manifestPath), error);
    assert.throws(() => buildReviewModel(manifest, manifestPath, verification), error);
    const databasePath = join(root, "reviews.sqlite");
    // Rejection must happen before reconstructing commits, executing tests, or storing a review.
    assert.throws(() => ingestNarrative({ id: "1", repo: root, narrativePath: manifestPath, databasePath }), error);
    assert.equal(getReview("1", databasePath), null);
  });

  test(`${kind}: complete coverage accepts supporting files and rejects unrelated paths`, () => {
    const { manifestPath, include, save } = fixture(kind);
    include("setup.ts");
    save();
    const { manifest } = loadManifest(manifestPath);
    const step = buildReviewModel(manifest, manifestPath, verification).steps[1];
    assert.equal(step.fileDiffs.length, 2);
    if (kind === "implementation") assert.equal(step.sections![1].files[0].change, "added");
    include("unrelated.ts");
    save();
    assert.throws(() => loadManifest(manifestPath), /unrelated\.ts, which is not changed/);
  });
}

test("implementation groups reject duplicated, unexplained, and invalid priorities", () => {
  const { manifestPath, step, include, save } = fixture("implementation");
  include("setup.ts");
  step.sections![1].files.push({ label: "Repeated logic", file: "logic.ts" });
  save();
  assert.throws(() => loadManifest(manifestPath), /logic\.ts more than once/);
  step.sections![1].files.pop();
  step.sections![1].description = " ";
  save();
  assert.throws(() => loadManifest(manifestPath), /description must be a non-empty string/);
  step.sections![1].description = "Supports the behavior";
  Object.assign(step.sections![1], { priority: "optional" });
  save();
  assert.throws(() => loadManifest(manifestPath), /priority must be critical or secondary/);
});
