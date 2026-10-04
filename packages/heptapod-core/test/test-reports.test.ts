import assert from "node:assert/strict";
import { test } from "vitest";
import { readTestReport } from "../src/tool/test-reports.js";
import { validateEvidenceCoverage } from "../src/tool/test-evidence-coverage.js";
import { stepEvidenceRequirements, type EvidenceFixture } from "../src/tool/test-evidence-requirements.js";
import type { NarrativeStep } from "../src/tool/types.js";

function google() {
  const raw = { tests: 3, failures: 1, errors: 0, testsuites: [{ name: "Suite", testsuite: [
    { name: "Pass", file: "tests/main.cpp", status: "RUN", result: "COMPLETED", time: "0.001s" },
    { name: "Fail", file: "tests/main.cpp", status: "RUN", result: "COMPLETED", time: "0.002s", failures: [{ failure: "assertion failed" }] },
    { name: "Skip", file: "tests/main.cpp", status: "RUN", result: "SKIPPED", time: "0s" },
  ] }] };
  const input = { id: "unit", path: "report.json", log: "log.txt", format: "googletest", root: "/checkout", command: "./tests", exitCode: 1 };
  const read = (path: string) => path === "log.txt" ? "runner output" : JSON.stringify(raw);
  return { raw, input, read };
}
test("GoogleTest derives pass/fail/skip outcomes and validates summary counts", () => {
  const f = google(); const report = readTestReport(f.input, f.read);
  assert.deepEqual(report.tests.map(test => test.status), ["passing", "failing", "not-run"]);
  assert.deepEqual(report.failures, ["tests/main.cpp > Suite.Fail"]);
  assert.equal(report.tests[1].durationMs, 2);
  f.raw.tests = 4; assert.throws(() => readTestReport(f.input, f.read), /summary counts/);
});
test("command receipts bind exact command/exit/log but cannot establish individual test passes", () => {
  const raw = { command: "pnpm typecheck", exitCode: 0, durationMs: 20, timedOut: false, output: "done" };
  const input = { id: "types", path: "receipt.json", log: "log.txt", format: "command", command: raw.command, exitCode: 0 };
  const read = (path: string) => path === "log.txt" ? "done" : JSON.stringify(raw);
  const report = readTestReport(input, read);
  const step: NarrativeStep = { id: "step", title: "Step", kind: "description", checks: { automated: [{ label: "Types", command: raw.command, status: "passing", basis: "expected" }], manual: [] } };
  const coverage = [{ target: "automated/0", status: "passing", results: [{ report: "types" }] }];
  assert.equal(validateEvidenceCoverage(coverage, stepEvidenceRequirements(step, []), [report])[0].status, "passing");
  step.checks.automated[0].command = "other";
  assert.throws(() => validateEvidenceCoverage(coverage, stepEvidenceRequirements(step, []), [report]), /command does not match/);
  assert.throws(() => validateEvidenceCoverage([{ ...coverage[0], target: "fixture/test.js" }], [{ target: "fixture/test.js", label: "Test", kind: "fixture", files: ["test.js"], notApplicable: false }], [report]), /command exits cannot prove/);
  raw.output = "different"; assert.throws(() => readTestReport(input, read), /contradicts/);
});
test("duplicate source test names require distinct reporter occurrences", () => {
  const step: NarrativeStep = { id: "step", title: "Step", kind: "tests", checks: { automated: [], manual: [] } };
  const declaration = { name: "same", key: "same", fingerprint: "", position: 0, endPosition: 0, line: 1, endLine: 1 };
  const fixtures: EvidenceFixture[] = [{ file: "test.js", deleted: false, tests: [declaration, declaration] }];
  const requirements = stepEvidenceRequirements(step, fixtures);
  const report = { id: "unit", path: "report.json", format: "vitest", command: "vitest", exitCode: 0, status: "passing" as const, output: "", failures: [], tests: [0, 1].map(() => ({ file: "test.js", name: "same", status: "passing" as const, durationMs: 1, failures: [] })) };
  const coverage = requirements.map((req, index) => ({ target: req.target, status: "passing", results: [{ report: "unit", tests: index === 0 ? [0, 1] : [index - 1] }] }));
  assert.equal(validateEvidenceCoverage(coverage, requirements, [report]).length, 3);
  coverage[2].results[0].tests = [0]; assert.throws(() => validateEvidenceCoverage(coverage, requirements, [report]), /omits a reported outcome|wrong occurrence/);
});
test("deleted tests require explicit not-applicable coverage instead of invented execution", () => {
  const requirement = { target: "test/old.js/0", label: "Removed test", kind: "test" as const, files: ["old.js"], notApplicable: true, name: "removed" };
  assert.equal(validateEvidenceCoverage([{ target: requirement.target, status: "not-applicable", results: [], detail: "Declaration removed in this step" }], [requirement], [])[0].status, "not-applicable");
  assert.throws(() => validateEvidenceCoverage([{ target: requirement.target, status: "passing", results: [] }], [requirement], []), /explicit blocker/);
});
