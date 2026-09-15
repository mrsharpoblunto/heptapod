import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

const git = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/tool/process.js", () => ({ run: git.run }));

import { getReview } from "../src/tool/database.js";
import { generatedFiles } from "../src/tool/generated-files.js";
import { ingestNarrative } from "../src/tool/ingest.js";
import { loadManifest } from "../src/tool/manifest.js";
import { buildReviewModel } from "../src/tool/model.js";
import type { NarrativeManifest, VerificationResult } from "../src/tool/types.js";

const directories: string[] = [];
let generated = new Set<string>();

beforeEach(() => {
  generated = new Set();
  git.run.mockImplementation((_command, args: string[], options: { input?: string | Buffer }) => {
    assert.deepEqual(args, ["check-attr", "-z", "--stdin", "linguist-generated"]);
    const paths = String(options.input ?? "").split("\0").filter(Boolean);
    const output = paths.flatMap(path => [path, "linguist-generated", generated.has(path) ? "set" : "unspecified"]);
    return { status: 0, stdout: Buffer.from(`${output.join("\0")}\0`), stderr: Buffer.alloc(0) };
  });
});

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const logicPatch = "diff --git a/logic.js b/logic.js\n--- a/logic.js\n+++ b/logic.js\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
const generatedPatch = "diff --git a/binding.generated.h b/binding.generated.h\n--- a/binding.generated.h\n+++ b/binding.generated.h\n@@ -1 +1 @@\n-old binding\n+new binding\n";

function narrative() {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-generated-unit-"));
  directories.push(repo);
  const artifact = join(repo, "artifacts");
  const manifestPath = join(artifact, "narrative.json");
  write(artifact, "source.diff", logicPatch + generatedPatch);
  write(artifact, "steps/01-problem.md", "Keep the value consistent with its generated bindings.\n");
  const manifest: NarrativeManifest = {
    schemaVersion: 1,
    title: "Generated files",
    summary: "Hide generated output from review.",
    source: { base: "a".repeat(40), head: "b".repeat(40), diff: "source.diff" },
    steps: [
      { id: "problem", title: "Problem", kind: "description", body: "steps/01-problem.md", checks: { automated: [], manual: [] } },
      {
        id: "change", title: "Update the value", kind: "implementation", diff: "source.diff",
        sections: [{ name: "Value", priority: "critical", description: "This source determines the value.", files: [{ label: "Value", file: "logic.js" }] }],
        checks: { automated: [], manual: [] },
      },
    ],
  };
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  save();
  return { repo, artifact, manifest, manifestPath, save, step: manifest.steps[1] };
}

test("Git attribute results are parsed without invoking Git", () => {
  const hidden = ["one.generated", "with space.generated.h", "café.generated.h", "line\nbreak.generated.h"];
  generated = new Set(hidden);
  assert.deepEqual([...generatedFiles("/mock/repository", [...hidden, "visible.ts", hidden[0]])].sort(), hidden.sort());
  assert.equal(generatedFiles("/mock/repository", []).size, 0);
  assert.equal(git.run.mock.calls.length, 1);
});

for (const kind of ["tests", "critical", "secondary", "interface", "callsite"] as const) {
  test(`${kind}: generated file references reject validation before ingestion`, () => {
    const { repo, manifestPath, step, save } = narrative();
    generated.add("binding.generated.h");
    const file = "binding.generated.h";
    if (kind === "tests") {
      step.kind = "tests";
      delete step.sections;
      step.cases = [{ name: "Value", description: "Covers generated support", files: ["logic.js", file] }];
    } else if (kind === "critical" || kind === "secondary") {
      step.sections!.push({ name: "Binding", priority: kind, description: "Generated output", files: [{ label: "Binding", file }] });
    } else {
      step.kind = "refactor";
      delete step.sections;
      step.interfaces = [{ name: "Value", file: kind === "interface" ? file : "logic.js", callsites: [{ label: "Caller", file: kind === "callsite" ? file : "logic.js" }] }];
    }
    save();
    const error = /binding\.generated\.h, which is excluded from review by the linguist-generated Git attribute/;
    assert.throws(() => loadManifest(manifestPath, repo), error);
    const databasePath = join(repo, "reviews.sqlite");
    assert.throws(() => ingestNarrative({ id: "1", repo, narrativePath: manifestPath, databasePath }), error);
    assert.equal(getReview("1", databasePath), null);
  });
}

test("generated source links cannot bypass exclusions", () => {
  const { repo, artifact, manifestPath, step, save } = narrative();
  generated.add("binding.generated.h");
  generated.add("unchanged.generated.h");
  step.sections![0].description = "See [bindings](./unchanged.generated.h#L1).";
  save();
  assert.throws(() => loadManifest(manifestPath, repo), /unchanged\.generated\.h, which is excluded/);
  step.sections![0].description = "This source determines the value.";
  save();
  write(artifact, "steps/01-problem.md", "See [bindings](binding.generated.h).\n");
  assert.throws(() => loadManifest(manifestPath, repo), /binding\.generated\.h, which is excluded/);
});

for (const kind of ["tests", "implementation", "refactor"] as const) {
  test(`${kind}: generated-only patches need no review groups`, () => {
    const { repo, manifestPath, step, save } = narrative();
    generated.add("binding.generated.h");
    step.kind = kind;
    delete step.sections;
    if (kind === "tests") step.cases = [];
    if (kind === "implementation") step.sections = [];
    if (kind === "refactor") step.interfaces = [];
    save();
    assert.throws(() => loadManifest(manifestPath, repo), /does not account for 1 file\(s\).*\n- logic\.js/);
    generated.add("logic.js");
    const { manifest } = loadManifest(manifestPath, repo);
    const verification: VerificationResult = {
      base: manifest.source.base, head: manifest.source.head, tree: "c".repeat(40),
      sourceBytes: Buffer.byteLength(logicPatch + generatedPatch), patchSteps: 1, exact: true,
      generatedFiles: [...generated],
    };
    const model = buildReviewModel(manifest, manifestPath, verification);
    assert.equal(model.steps[1].patch, "");
    assert.deepEqual(model.steps[1].fileDiffs, []);
    assert.equal(model.source.stats.files, 0);
  });
}
