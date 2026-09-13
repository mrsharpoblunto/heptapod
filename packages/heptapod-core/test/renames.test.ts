import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { captureNarrative } from "../src/tool/capture.js";
import { DIFF_ARGS } from "../src/tool/git.js";
import { buildReviewModel } from "../src/tool/model.js";
import { patchRename, splitPatchFiles } from "../src/tool/patch.js";
import { analyzeNarrative } from "../src/tool/test-analysis.js";
import type { NarrativeManifest } from "../src/tool/types.js";
import { verifyNarrative } from "../src/tool/verify.js";

test("rename paths preserve prefixes, spaces, and Git-quoted Unicode", () => {
  const patch = 'diff --git a/a/old name.ts b/b/new name.ts\nsimilarity index 100%\nrename from a/old name.ts\nrename to b/new name.ts\n';
  assert.deepEqual(patchRename(patch), { from: "a/old name.ts", to: "b/new name.ts" });
  assert.deepEqual(splitPatchFiles(patch), [{ path: "b/new name.ts", from: "a/old name.ts", patch }]);
  assert.deepEqual(patchRename(String.raw`rename from "a/caf\303\251.ts"
rename to "b/caf\303\251.ts"
`), { from: "a/café.ts", to: "b/café.ts" });
  assert.equal(patchRename("diff --git a/file b/file\n@@ -1 +1 @@\n rename from old\n rename to new\n"), null);
});

for (const edited of [false, true]) test(`analyzes moved fixtures${edited ? " with edits" : ""}`, () => {
  const root = mkdtempSync(join(tmpdir(), "heptapod-renames-"));
  const repo = join(root, "repo");
  const artifact = join(root, "artifact");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString("utf8");
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    const before = "it('stable', () => expect(1).toBe(1));\nit('editable', () => expect(2).toBe(2));\nit('also stable', () => expect(3).toBe(3));\n";
    writeFileSync(join(repo, "old.test.js"), before);
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    git("mv", "old.test.js", "new.test.js");
    if (edited) writeFileSync(join(repo, "new.test.js"), before.replace("expect(2)", "expect(4)") + "it('added', () => expect(5).toBe(5));\n");
    git("add", ".");
    git("commit", "-qm", "move");
    const head = git("rev-parse", "HEAD").trim();
    captureNarrative(repo, base, head, artifact, { databasePath: join(root, "reviews.sqlite") });
    const manifestPath = join(artifact, "narrative.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NarrativeManifest;
    writeFileSync(join(artifact, "move.diff"), git("diff", ...DIFF_ARGS, base, head));
    manifest.steps = [{
      id: "move", title: "Move files", kind: "tests", diff: "move.diff",
      checks: { automated: [], manual: [] },
      cases: [{ name: "Relocate", description: "Move fixtures", files: ["new.test.js"] }],
    }];
    const analysis = analyzeNarrative(repo, manifest, manifestPath);
    const verification = verifyNarrative(repo, manifest, manifestPath);
    const model = buildReviewModel(manifest, manifestPath, verification, analysis.testAreasByStep, analysis.filesByStep);
    assert.equal(model.steps[0].fileDiffs[0].beforeContent, before);
    assert.deepEqual(model.steps[0].testAreas?.[0].files[0].cases.map(({ name, change }) => [name, change]), [
      ["stable", "moved"], ["editable", edited ? "changed" : "moved"], ["also stable", "moved"], ...(edited ? [["added", "added"]] : []),
    ]);
    manifest.steps[0] = {
      id: "move", title: "Move files", kind: "implementation", diff: "move.diff", checks: { automated: [], manual: [] },
      sections: [{ name: "Support", description: "Relocate", priority: "secondary", files: [{ file: "new.test.js", label: "Fixture", change: "added" }] }],
    };
    const implementation = buildReviewModel(manifest, manifestPath, verification, analysis.testAreasByStep, analysis.filesByStep);
    assert.equal(implementation.steps[0].sections?.[0].files[0].change, "moved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
