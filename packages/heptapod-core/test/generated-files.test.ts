import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import { captureNarrative } from "../src/tool/capture.js";
import { getReview } from "../src/tool/database.js";
import { generatedFiles } from "../src/tool/generated-files.js";
import { ingestNarrative } from "../src/tool/ingest.js";
import { loadManifest } from "../src/tool/manifest.js";
import { buildReviewModel } from "../src/tool/model.js";
import { splitPatchFiles } from "../src/tool/patch.js";
import { analyzeNarrative } from "../src/tool/test-analysis.js";
import type { NarrativeManifest } from "../src/tool/types.js";
import { verifyNarrative } from "../src/tool/verify.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-generated-"));
  directories.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString("utf8").trim();
  git("init", "-q");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  return { repo, git, write };
}

test("Git attribute matching honors nested rules, overrides and unusual paths", () => {
  const { repo, git, write } = repository();
  write(".gitattributes", [
    "*.generated linguist-generated",
    "*.generated.* linguist-generated=true",
    "output/** linguist-generated=custom-value",
    "vendor/** linguist-vendored=true",
    "visible.generated linguist-generated=false",
    "unset.generated -linguist-generated",
    "reset.generated !linguist-generated",
  ].join("\n") + "\n");
  write("nested/.gitattributes", "*.generated.* -linguist-generated\nkeep.generated.h linguist-generated\n");
  git("add", ".");
  // Attribute files need not be committed, and indexed rules work after deletion.
  rmSync(join(repo, "nested/.gitattributes"));
  const hidden = ["one.generated", "deep/two.generated.h", "with space.generated.h", "café.generated.h", "line\nbreak.generated.h", "output/plain.txt", "nested/keep.generated.h"];
  const visible = ["visible.generated", "unset.generated", "reset.generated", "nested/two.generated.h", "vendor/handwritten.js", "plain.txt"];
  assert.deepEqual([...generatedFiles(repo, [...hidden, ...visible, hidden[0]])].sort(), hidden.sort());
  assert.equal(generatedFiles(repo, []).size, 0);
});

function narrative() {
  const context = repository();
  const { repo, git, write } = context;
  write("logic.js", "export const value = 1;\n");
  write("binding.generated.h", "old binding\n");
  write("unchanged.generated.h", "unchanged binding\n");
  write("deleted.generated.h", "deleted binding\n");
  write("café.generated.h", "old unicode binding\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  write("logic.js", "export const value = 2;\n");
  write("binding.generated.h", "new binding\n");
  write("café.generated.h", "new unicode binding\n");
  write("binary.generated", Buffer.from([0, 1, 2, 3]));
  rmSync(join(repo, "deleted.generated.h"));
  git("add", "."); git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  // Current repository policy applies to comparisons pinned before these rules.
  write(".gitattributes", "*.generated linguist-generated\n*.generated.* linguist-generated=true\n");
  const artifact = join(repo, "artifacts");
  captureNarrative(repo, base, head, artifact);
  const manifestPath = join(artifact, "narrative.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NarrativeManifest;
  const source = readFileSync(join(artifact, "source.diff"));
  write("artifacts/steps/01-problem.md", "Keep the value consistent with its generated bindings.\n");
  manifest.steps.push({
    id: "change", title: "Update the value", kind: "implementation", diff: "source.diff",
    sections: [{ name: "Value", priority: "critical", description: "This source determines the value.", files: [{ label: "Value", file: "logic.js" }] }],
    checks: { automated: [], manual: [] },
  });
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  save();
  return { ...context, manifest, manifestPath, source, save, step: manifest.steps[1] };
}

test("generated changes stay in exact reconstruction but disappear from review files and stats", () => {
  const { repo, git, manifestPath, source } = narrative();
  const { manifest, generated } = loadManifest(manifestPath, repo);
  assert.equal(generated.size, 4);
  const verification = verifyNarrative(repo, manifest, manifestPath);
  assert.equal(verification.tree, git("rev-parse", `${manifest.source.head}^{tree}`));
  assert.equal(verification.sourceBytes, source.length);
  const analysis = analyzeNarrative(repo, manifest, manifestPath);
  assert.deepEqual([...analysis.filesByStep.get("change")!.keys()], ["logic.js"]);
  const review = ingestNarrative({ id: "1", repo, narrativePath: manifestPath, databasePath: join(repo, "reviews.sqlite") });
  assert.deepEqual(review.payload.steps[1].fileDiffs.map((file) => file.path), ["logic.js"]);
  assert.deepEqual(review.payload.source.files?.map((file) => file.path), ["logic.js"]);
  assert.deepEqual(review.payload.steps[1].stats, { files: 1, additions: 1, deletions: 1 });
  assert.deepEqual(review.payload.source.stats, { files: 1, additions: 1, deletions: 1 });
  assert.deepEqual(splitPatchFiles(review.payload.steps[1].patch).map((file) => file.path), ["logic.js"]);
  assert.deepEqual(readFileSync(join(dirname(manifestPath), "source.diff")), source);
});

for (const kind of ["tests", "critical", "secondary", "interface", "callsite"] as const) {
  test(`${kind}: generated file references reject validation and ingestion before storage`, () => {
    const { repo, manifest, manifestPath, step, save } = narrative();
    const file = "binding.generated.h";
    if (kind === "tests") {
      step.kind = "tests";
      delete step.sections;
      step.cases = [{ name: "Value", description: "Covers the value and its supporting files", files: ["logic.js", file] }];
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
    assert.throws(() => verifyNarrative(repo, manifest, manifestPath), error);
    const databasePath = join(repo, "reviews.sqlite");
    assert.throws(() => ingestNarrative({ id: "1", repo, narrativePath: manifestPath, databasePath }), error);
    assert.equal(getReview("1", databasePath), null);
  });
}

test("generated source links cannot bypass exclusions through Markdown or unchanged files", () => {
  const { repo, write, manifestPath, step, save } = narrative();
  step.sections![0].description = "See [bindings](./unchanged.generated.h#L1).";
  save();
  assert.throws(() => loadManifest(manifestPath, repo), /unchanged\.generated\.h, which is excluded/);
  step.sections![0].description = "This source determines the value.";
  save();
  write("artifacts/steps/01-problem.md", "See [bindings](binding.generated.h).\n");
  assert.throws(() => loadManifest(manifestPath, repo), /binding\.generated\.h, which is excluded/);
});

for (const kind of ["tests", "implementation", "refactor"] as const) {
  test(`${kind}: generated-only patches need no groups, while visible omissions still fail`, () => {
    const { repo, write, manifestPath, manifest, step, save, source } = narrative();
    step.kind = kind;
    delete step.sections;
    if (kind === "tests") step.cases = [];
    if (kind === "implementation") step.sections = [];
    if (kind === "refactor") step.interfaces = [];
    save();
    assert.throws(() => loadManifest(manifestPath, repo), /does not account for 1 file\(s\).*\n- logic\.js/);
    write(".gitattributes", "* linguist-generated\n");
    loadManifest(manifestPath, repo);
    const verification = verifyNarrative(repo, manifest, manifestPath);
    const model = buildReviewModel(manifest, manifestPath, verification);
    assert.equal(model.steps[1].patch, "");
    assert.deepEqual(model.steps[1].fileDiffs, []);
    assert.equal(model.source.stats.files, 0);
    assert.equal(verification.sourceBytes, source.length);
  });
}
