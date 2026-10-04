import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { loadTestEvidence } from "../src/tool/test-evidence.js";
import { verifyNarrative } from "../src/tool/verify.js";
import { ingestNarrative } from "../src/tool/ingest.js";
import { canonicalDiff } from "../src/tool/git.js";
import { analyzeNarrative } from "../src/tool/test-analysis.js";
import { evidenceRequirements, type EvidenceFixture } from "../src/tool/test-evidence-requirements.js";
import type { NarrativeManifest, VerificationResult } from "../src/tool/types.js";

vi.mock("../src/tool/source-checkout.js", () => ({ buildEditorLinks: () => ({}) }));
vi.mock("../src/tool/semantic-diff.js", () => ({ generateSemanticDiffs: () => {} }));
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "heptapod-evidence-")); directories.push(root);
  const manifest: NarrativeManifest = {
    schemaVersion: 1, title: "Change", summary: "Change behavior",
    source: { base: "a".repeat(40), head: "b".repeat(40), diff: "source.diff" },
    steps: [{ id: "change", title: "Change", kind: "tests", cases: [{ name: "Behavior", description: "Coverage", files: ["test.js"] }], checks: { automated: [{ label: "expected regression", status: "passing", basis: "expected" }], manual: [] } }],
  };
  const verification: VerificationResult = { ...manifest.source, tree: "c".repeat(40), sourceBytes: 0, patchSteps: 0, exact: true, stepTrees: { change: "c".repeat(40) } };
  const fixtures = new Map<string, EvidenceFixture[]>([["change", [{ file: "test.js", deleted: false, tests: [{ name: "expected regression", key: "expected regression", fingerprint: "", position: 0, endPosition: 0, line: 1, endLine: 1 }] }]]]);
  const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
    testResults: [{ name: `${root}/test.js`, status: "passed", assertionResults: [{ fullName: "expected regression", status: "passed", duration: 12, failureMessages: [] as string[] }] }] };
  const entry = { stepId: "change", tree: verification.tree, scope: "full-suite", files: ["test.js"], command: "pnpm vitest run", status: "passing", exitCode: 0 as number | null, durationMs: 12, failures: [] as string[], log: "output.txt",
    reports: [{ id: "unit", path: "report.json", format: "vitest", root, command: "pnpm vitest run", exitCode: 0 as number | null, log: "output.txt" }],
    coverage: evidenceRequirements(manifest, fixtures).get("change")!.map(requirement => ({ target: requirement.target, status: "passing", results: [{ report: "unit" }], detail: "" })),
  };
  // Omit optional detail rather than emitting empty strings.
  for (const coverage of entry.coverage) Object.assign(coverage, { detail: undefined });
  const evidence = { schemaVersion: 2, base: manifest.source.base, head: manifest.source.head, timeoutMs: 1000, results: [entry] };
  const manifestPath = join(root, "narrative.json");
  writeFileSync(join(root, "output.txt"), "Actual test output\n");
  const save = () => { writeFileSync(join(root, "test-results.json"), JSON.stringify(evidence)); writeFileSync(join(root, "report.json"), JSON.stringify(report)); }; save();
  const load = () => loadTestEvidence(manifest, manifestPath, verification, fixtures);
  return { root, manifest, manifestPath, verification, entry, evidence, fixtures, report, save, load };
}

test("requires report-backed data for checks, areas, fixtures and individual declarations", () => {
  const f = fixture();
  const run = f.load().runsByStep.get("change")!;
  assert.equal(run.status, "passing"); assert.equal(run.metadataResults?.length, 4);
  assert.equal(run.fixtureRuns[0].status, "passing"); assert.match(run.fixtureRuns[0].output, /Actual test output/);
  for (let index = 0; index < 4; index++) {
    const removed = f.entry.coverage.splice(index, 1)[0]; f.save(); assert.throws(f.load, /missing results/); f.entry.coverage.splice(index, 0, removed);
  }
  f.entry.coverage.push(f.entry.coverage[0]); f.save(); assert.throws(f.load, /duplicate target/);
});

test("rejects missing, duplicate, stale and contradictory step evidence", () => {
  const f = fixture();
  f.entry.tree = "d".repeat(40); f.save(); assert.throws(f.load, /tested tree/);
  f.entry.tree = f.verification.tree; f.evidence.head = "d".repeat(40); f.save(); assert.throws(f.load, /source revisions/);
  f.evidence.head = f.manifest.source.head; f.entry.exitCode = 1; f.save(); assert.throws(f.load, /passing conflicts/);
  f.entry.exitCode = 0; f.entry.scope = "changed-tests"; f.save(); assert.throws(f.load, /final step/);
  f.entry.scope = "full-suite"; f.evidence.results.push(f.entry); f.save(); assert.throws(f.load, /duplicate/);
  f.evidence.results = []; f.save(); assert.throws(f.load, /every step/);
  rmSync(join(f.root, "test-results.json")); assert.throws(f.load, /does not exist/);
});

test("rejects fabricated passing results and missing or misidentified reporter tests", () => {
  const f = fixture();
  const assertion = f.report.testResults[0].assertionResults[0];
  assertion.status = "failed"; assertion.failureMessages = ["boom"];
  f.report.success = false; f.report.numPassedTests = 0; f.report.numFailedTests = 1; f.report.testResults[0].status = "failed";
  f.save(); assert.throws(f.load, /aggregate status contradicts/);
  f.entry.status = "failing"; f.entry.exitCode = 1; f.entry.reports[0].exitCode = 1;
  f.save(); assert.throws(f.load, /failures must match/);
  f.entry.failures = ["test.js > expected regression"];
  f.save(); assert.throws(f.load, /contradicts report outcome/);
  f.entry.coverage.forEach(coverage => coverage.status = "failing"); f.save();
  assert.equal(f.load().runsByStep.get("change")!.metadataResults![0].expectationMatched, false);
  f.manifest.steps[0].checks.automated[0].status = "failing";
  f.manifest.steps[0].checks.automated[0].label = "Broader behavior contract";
  assert.equal(f.load().runsByStep.get("change")!.expectationMatched, true);
  assertion.fullName = "an unrelated test"; f.entry.failures = ["test.js > an unrelated test"]; f.save();
  assert.throws(f.load, /does not match the metadata/);
});

test("requires an explicit blocker per entry and never promotes skipped tests to passing", () => {
  const f = fixture();
  f.report.testResults[0].assertionResults[0].status = "pending"; f.report.numPassedTests = 0;
  f.save(); assert.throws(f.load, /aggregate status contradicts/);
  f.entry.status = "not-run"; Object.assign(f.entry, { command: null, exitCode: null, detail: "All tests skipped" });
  f.entry.coverage.forEach(coverage => Object.assign(coverage, { status: "not-run", detail: "Test runner skipped this entry" })); f.save();
  assert.equal(f.load().runsByStep.get("change")!.fixtureRuns[0].status, "not-run");
  f.entry.reports = []; f.entry.coverage.forEach(coverage => coverage.results = []); f.save();
  assert.equal(f.load().runsByStep.get("change")!.metadataResults![0].status, "not-run");
  Object.assign(f.entry.coverage[0], { detail: undefined }); f.save(); assert.throws(f.load, /explicit blocker/);
});

test("validates log/report boundaries and report completeness", () => {
  const f = fixture();
  f.entry.reports[0].path = "../outside.json"; f.save(); assert.throws(f.load, /inside the artifact/);
  const outside = mkdtempSync(join(tmpdir(), "heptapod-outside-")); directories.push(outside);
  writeFileSync(join(outside, "secret.txt"), "outside"); symlinkSync(join(outside, "secret.txt"), join(f.root, "linked.json"));
  f.entry.reports[0].path = "linked.json"; f.save(); assert.throws(f.load, /inside the artifact/);
  f.entry.reports[0].path = "report.json"; f.report.numTotalTests = 2; f.save(); assert.throws(f.load, /summary counts/);
  f.report.numTotalTests = 1; f.entry.reports.push(f.entry.reports[0]); f.save(); assert.throws(f.load, /duplicate report/);
});

test("does not let a partial selection hide another failure in the same fixture", () => {
  const f = fixture();
  f.report.testResults[0].assertionResults.push({ fullName: "unrelated failure", status: "failed", duration: 1, failureMessages: ["boom"] });
  f.report.numTotalTests = 2; f.report.numFailedTests = 1; f.report.success = false; f.report.testResults[0].status = "failed";
  f.entry.status = "failing"; f.entry.exitCode = 1; f.entry.reports[0].exitCode = 1; f.entry.failures = ["test.js > unrelated failure"];
  for (const coverage of f.entry.coverage) Object.assign(coverage, { results: [{ report: "unit", tests: [0] }] });
  f.save(); assert.throws(f.load, /omits a reported outcome/);
});

test("ingestion derives required metadata from real Git states without running tests", () => {
  const f = fixture();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  writeFileSync(join(f.root, "code.txt"), "before\n"); git("add", "code.txt"); git("commit", "-qm", "Base"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(f.root, "test.js"), "test('expected regression', () => {});\n"); git("add", "test.js"); git("commit", "-qm", "Tests"); const head = git("rev-parse", "HEAD");
  writeFileSync(join(f.root, "source.diff"), canonicalDiff(f.root, base, head));
  f.manifest.source.base = base; f.manifest.source.head = head; f.manifest.steps[0].diff = "source.diff";
  f.manifest.steps.unshift({ id: "context", title: "Context", kind: "description", body: "context.md", checks: { automated: [], manual: [] } });
  writeFileSync(join(f.root, "context.md"), "Explain the change.\n"); writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  const verification = verifyNarrative(f.root, f.manifest, f.manifestPath);
  const analysis = analyzeNarrative(f.root, f.manifest, f.manifestPath);
  assert.deepEqual(evidenceRequirements(f.manifest, analysis.testFixturesByStep).get("change")!.map(item => item.target), ["automated/0", "area/0", "fixture/test.js", "test/test.js/0"]);
  f.evidence.base = base; f.evidence.head = head; f.entry.tree = verification.stepTrees!.change;
  f.evidence.results.unshift({ ...f.entry, stepId: "context", tree: verification.stepTrees!.context, scope: "changed-tests", files: [], reports: [], coverage: [], status: "not-run", command: null as unknown as string, exitCode: null, detail: "No changed tests" } as typeof f.entry); f.save();
  const sentinel = join(f.root, "TESTS_EXECUTED");
  writeFileSync(join(f.root, ".heptapod.json"), JSON.stringify({ test: { runner: { format: "command", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`] } } }));
  const ingest = () => ingestNarrative({ id: "1", repo: f.root, narrativePath: f.manifestPath, databasePath: join(f.root, "review.sqlite") });
  const missing = f.entry.coverage.pop()!; f.save(); assert.throws(ingest, /missing results for test\/test.js\/0/);
  f.entry.coverage.push(missing); f.save(); const review = ingest();
  assert.equal(review.status, "ready"); assert.equal(review.payload.steps[1].testRun?.metadataResults?.length, 4);
  assert.equal(existsSync(sentinel), false);
});
