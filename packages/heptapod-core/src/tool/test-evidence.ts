import { readTestReport } from "./test-reports.js";
import { validateEvidenceCoverage, aggregateStatuses } from "./test-evidence-coverage.js";
import { evidenceRequirements, type EvidenceFixture } from "./test-evidence-requirements.js";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { resolveArtifactPath } from "./manifest.js";
import type { NarrativeTestExecution } from "./test-execution.js";
import type { NarrativeManifest, NarrativeStep, StepTestRun, VerificationResult } from "./types.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid test-results.json: ${message}`);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected an object");
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim());
}
function artifact(manifestPath: string, path: string): string {
  const target = realpathSync(resolveArtifactPath(manifestPath, path, "test evidence"));
  const traversal = relative(realpathSync(dirname(manifestPath)), target);
  assert(traversal !== ".." && !traversal.startsWith(`..${sep}`), "evidence must stay inside the artifact directory");
  return readFileSync(target, "utf8");
}

function result(value: unknown, step: NarrativeStep, manifestPath: string): StepTestRun {
  object(value);
  assert(value.scope === "changed-tests" || value.scope === "full-suite", `${step.id}: invalid scope`);
  assert(strings(value.files), `${step.id}: files must be a string array`);
  assert(value.files.every(file => !/^(?:[\\/]|[A-Za-z]:)/.test(file) && !file.split(/[\\/]/).includes("..") && !file.includes("\0")), `${step.id}: files must be repository-relative paths`);
  assert(typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0, `${step.id}: invalid durationMs`);
  assert(value.detail === undefined || (typeof value.detail === "string" && value.detail.trim()), `${step.id}: invalid detail`);
  assert(value.status === "passing" || value.status === "failing" || value.status === "timed-out" || value.status === "not-run", `${step.id}: invalid status`);
  assert(value.exitCode === null || (Number.isInteger(value.exitCode) && Number(value.exitCode) >= 0), `${step.id}: invalid exitCode`);
  assert(strings(value.failures), `${step.id}: failures must be a string array`);
  assert(value.log === undefined || typeof value.log === "string", `${step.id}: invalid log`);
  const output = typeof value.log === "string" ? artifact(manifestPath, value.log) : "";
  const expectedFailures = step.checks.automated.filter(check => check.status === "failing").map(check => check.label);
  const comparable = step.checks.automated.filter(check => check.status !== "not-applicable");
  const expectedStatus = expectedFailures.length ? "failing" :
    comparable.length && comparable.every(check => check.status === "passing") ? "passing" : "not-specified";
  if (value.status === "not-run") {
    assert(value.command === null && value.exitCode === null && value.failures.length === 0 && value.detail, `${step.id}: not-run needs null command/exitCode, no failures, and a reason`);
    return {
      command: null, scope: value.scope, files: value.files, status: "not-run", exitCode: null,
      durationMs: value.durationMs, expectedStatus,
      expectationMatched: null, expectedFailures, observedFailures: [], unexpectedFailures: [],
      fixtureRuns: [], output: output.slice(-200_000), detail: value.detail as string,
    };
  }
  assert(typeof value.command === "string" && value.command.trim(), `${step.id}: executed results need a command`);
  assert(typeof value.log === "string", `${step.id}: executed results need a log artifact`);
  assert(value.status !== "passing" || (value.exitCode === 0 && value.failures.length === 0), `${step.id}: passing conflicts with exitCode or failures`);
  assert(value.status !== "failing" || value.exitCode !== 0 || value.failures.length > 0, `${step.id}: failing needs a nonzero/null exitCode or reported failures`);
  assert(value.status !== "timed-out" || value.exitCode === null, `${step.id}: timed-out needs a null exitCode`);
  return {
    command: value.command, scope: value.scope, files: value.files, status: value.status,
    exitCode: value.exitCode as number | null, durationMs: value.durationMs, expectedStatus,
    expectationMatched: expectedStatus === "not-specified" || value.status === "timed-out" ? null :
      expectedStatus === value.status,
    expectedFailures, observedFailures: value.failures, unexpectedFailures: [],
    fixtureRuns: [], output: output.slice(-200_000), ...(value.detail ? { detail: value.detail as string } : {}),
  };
}

/** Validate reported evidence; never execute repository setup, builds, or tests. */
export function loadTestEvidence(manifest: NarrativeManifest, manifestPath: string, verification: VerificationResult, fixturesByStep: Map<string, EvidenceFixture[]>): NarrativeTestExecution {
  const evidence: unknown = JSON.parse(artifact(manifestPath, "test-results.json"));
  object(evidence);
  assert(evidence.schemaVersion === 2, "schemaVersion must be 2; per-metadata coverage and runner reports are required");
  assert(evidence.base === manifest.source.base && evidence.head === manifest.source.head, "source revisions do not match the narrative");
  assert(typeof evidence.timeoutMs === "number" && Number.isFinite(evidence.timeoutMs) && evidence.timeoutMs > 0, "timeoutMs must be positive");
  assert(Array.isArray(evidence.results), "results must be an array");
  const requirements = evidenceRequirements(manifest, fixturesByStep);
  const steps = new Map(manifest.steps.map(step => [step.id, step]));
  const runsByStep = new Map<string, StepTestRun>();
  const reportTrees = new Map<string, string>();
  for (const entry of evidence.results) {
    object(entry);
    assert(typeof entry.stepId === "string", "stepId is required");
    const step = steps.get(entry.stepId);
    assert(step && !runsByStep.has(step.id), `unknown or duplicate step: ${entry.stepId}`);
    assert(typeof entry.tree === "string" && entry.tree === verification.stepTrees?.[step.id], `${step.id}: tested tree does not match the reconstructed step`);
    const run = result(entry, step, manifestPath);
    assert(entry.fixtures === undefined, `${step.id}: fixture results are derived from reports; use coverage`);
    assert(Array.isArray(entry.reports), `${step.id}: reports must be an array`);
    const reports = entry.reports.map(report => readTestReport(report, path => artifact(manifestPath, path)));
    assert(new Set(reports.map(report => report.id)).size === reports.length, `${step.id}: duplicate report IDs`);
    assert(new Set(reports.map(report => realpathSync(resolveArtifactPath(manifestPath, report.path, "report")))).size === reports.length, `${step.id}: duplicate report artifacts`);
    const fixtureFiles = (fixturesByStep.get(step.id) ?? []).map(fixture => fixture.file);
    const reportedFiles = new Set(reports.flatMap(report => report.tests.map(test => test.file)));
    assert(fixtureFiles.every(file => run.files.includes(file)), `${step.id}: files omit a required fixture`);
    assert(run.files.every(file => fixtureFiles.includes(file) || reportedFiles.has(file)), `${step.id}: files claim a fixture absent from metadata and reports`);
    for (const report of reports) {
      const path = realpathSync(resolveArtifactPath(manifestPath, report.path, "report"));
      assert(!reportTrees.has(path) || reportTrees.get(path) === entry.tree, `${step.id}: a report artifact cannot be reused for a different tree`);
      reportTrees.set(path, entry.tree);
    }
    if (run.status !== "not-run") assert(reports.length > 0, `${step.id}: executed runs require reports`);
    if (reports.length) {
      const status = aggregateStatuses(reports.map(report => report.status));
      const command = [...new Set(reports.map(report => report.command))].join(" && ");
      if (run.status !== "not-run") assert(run.command === command, `${step.id}: aggregate command contradicts reports`);
      run.output = reports.map(report => `$ ${report.command}\n${report.output}`).join("\n\n").slice(-200_000);
      assert(run.status === status, `${step.id}: aggregate status contradicts runner reports (${status})`);
      if (run.exitCode === 0) assert(reports.every(report => report.exitCode === 0), `${step.id}: aggregate exitCode hides a failed command`);
      const failures = reports.flatMap(report => report.failures);
      assert(failures.every(failure => run.observedFailures.includes(failure)) && run.observedFailures.every(failure => failures.includes(failure)), `${step.id}: failures must match runner reports exactly`);
    }
    run.metadataResults = validateEvidenceCoverage(entry.coverage, requirements.get(step.id)!, reports);
    const expectedFailureData = new Set<string>();
    for (const [index, check] of step.checks.automated.entries()) {
      if (check.status !== "failing") continue;
      const covered = run.metadataResults.find(item => item.target === `automated/${index}`)!;
      for (const reference of covered.results) {
        const report = reports.find(report => report.id === reference.report)!;
        for (const failure of reference.tests === undefined ? report.failures : reference.tests.flatMap(index => {
          const test = report.tests[index];
          return test.status === "failing" ? [`${test.file} > ${test.name}`] : [];
        })) expectedFailureData.add(failure);
      }
    }
    run.unexpectedFailures = run.observedFailures.filter(failure => !expectedFailureData.has(failure));
    if ((run.status === "failing" || run.status === "timed-out") && !run.observedFailures.length) {
      run.unexpectedFailures.push(run.detail || "Command did not complete successfully; inspect its process log.");
    }
    if (run.expectationMatched !== null) run.expectationMatched = run.expectedStatus === run.status && run.unexpectedFailures.length === 0;
    if (run.metadataResults.some(item => item.expectationMatched === false)) run.expectationMatched = false;
    for (const fixture of fixturesByStep.get(step.id) ?? []) {
      const target = `fixture/${encodeURIComponent(fixture.file)}`;
      const covered = run.metadataResults.find(item => item.target === target)!;
      const matching = reports.flatMap(report => report.tests.filter(test => test.file === fixture.file));
      const observedFailures = matching.filter(test => test.status === "failing").map(test => `${fixture.file} > ${test.name}`);
      const related = reports.filter(report => report.tests.some(test => test.file === fixture.file));
      run.fixtureRuns.push({ file: fixture.file, command: related.map(report => report.command).join(" && "),
        status: covered.status === "not-applicable" ? "not-run" : covered.status,
        expectedStatus: run.expectedStatus, expectationMatched: covered.expectationMatched,
        exitCode: related.find(report => report.exitCode !== 0)?.exitCode ?? (related.length ? 0 : null),
        durationMs: matching.reduce((total, test) => total + test.durationMs, 0), observedFailures,
        unexpectedFailures: observedFailures.filter(failure => run.unexpectedFailures.includes(failure)),
        output: related.map(report => report.output).join("\n").slice(-200_000), detail: covered.detail,
      });
    }
    assert(step !== manifest.steps.at(-1) || run.scope === "full-suite", `${step.id}: final step must report the full suite (or explain why it was not run)`);
    runsByStep.set(step.id, run);
  }
  assert(runsByStep.size === steps.size, "every step needs a result, including explicit not-run reasons");
  return {
    metadata: { source: "agent", command: runsByStep.get(manifest.steps.at(-1)!.id)!.command, worktreeBase: evidence.base as string, timeoutMs: evidence.timeoutMs },
    runsByStep,
  };
}
