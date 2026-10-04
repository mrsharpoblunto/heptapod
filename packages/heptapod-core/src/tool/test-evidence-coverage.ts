import type { EvidenceRequirement } from "./test-evidence-requirements.js";
import type { TestReport, ReportedTest } from "./test-reports.js";
import type { MetadataTestResult, ObservedTestStatus } from "./types.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid test evidence coverage: ${message}`);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected an object");
}
export function aggregateStatuses(statuses: ObservedTestStatus[]): ObservedTestStatus {
  return statuses.includes("timed-out") ? "timed-out" : statuses.includes("failing") ? "failing" :
    statuses.length && statuses.every(status => status === "passing") ? "passing" : "not-run";
}
function matches(requirement: EvidenceRequirement, test: ReportedTest): boolean {
  if (!requirement.files.includes(test.file)) return false;
  if (requirement.kind !== "test") return true;
  if (!requirement.selectors) return test.name === requirement.name;
  return requirement.selectors.some(selector => new RegExp(`^${selector.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(test.name));
}

/** Require one explicit result for each metadata/source target, and derive it from reports. */
export function validateEvidenceCoverage(value: unknown, requirements: EvidenceRequirement[], reports: TestReport[]): MetadataTestResult[] {
  assert(Array.isArray(value), "coverage must be an array");
  const required = new Map(requirements.map(requirement => [requirement.target, requirement]));
  const seen = new Set<string>();
  const results: MetadataTestResult[] = [];
  for (const entry of value) {
    object(entry);
    assert(typeof entry.target === "string", "target is required");
    const requirement = required.get(entry.target);
    assert(requirement && !seen.has(entry.target), `unknown or duplicate target ${entry.target}`); seen.add(entry.target);
    assert(Array.isArray(entry.results), `${entry.target}: results must be an array`);
    assert(entry.detail === undefined || (typeof entry.detail === "string" && entry.detail.trim()), `${entry.target}: invalid detail`);
    const selected = new Set<string>();
    const statuses: ObservedTestStatus[] = [];
    const commands = new Set<string>();
    for (const ref of entry.results) {
      object(ref);
      const report = reports.find(report => report.id === ref.report);
      assert(report, `${entry.target}: unknown report ${String(ref.report)}`);
      commands.add(report.command);
      if (report.format === "command") {
        assert(requirement.kind === "check" && ref.tests === undefined, `${entry.target}: command exits cannot prove fixture or test outcomes`);
        statuses.push(report.status); continue;
      }
      assert(ref.tests === undefined || (Array.isArray(ref.tests) && ref.tests.length > 0), `${entry.target}: tests must be a nonempty array of report test indexes`);
      const indexes = ref.tests ?? report.tests.map((_test, index) => index);
      for (const index of indexes) {
        assert(Number.isInteger(index) && index >= 0 && index < report.tests.length, `${entry.target}: unknown test index`);
        const key = JSON.stringify([report.id, index]);
        assert(!selected.has(key), `${entry.target}: duplicate report test reference`); selected.add(key);
        const test = report.tests[index];
        assert(requirement.kind === "check" || matches(requirement, test), `${entry.target}: referenced test does not match the metadata`);
        statuses.push(test.status);
      }
      // Whole-report references also account for suite-level errors and process failures.
      if (ref.tests === undefined) statuses.push(report.status);
    }
    if (requirement.command && commands.size) assert(commands.has(requirement.command), `${entry.target}: evidence command does not match the metadata command`);
    if (requirement.kind !== "check") {
      for (const report of reports) {
        const matching = report.tests.map((test, index) => ({ test, index })).filter(({ test }) => matches(requirement, test));
        const expected = requirement.kind === "test" && !requirement.selectors ? matching.slice(requirement.occurrence ?? 0, (requirement.occurrence ?? 0) + 1) : matching;
        for (const { index } of expected) {
          assert(selected.has(JSON.stringify([report.id, index])), `${entry.target}: omits a reported outcome for this metadata entry`);
        }
        if (requirement.kind === "test" && !requirement.selectors) {
          const allowed = new Set(expected.map(({ index }) => JSON.stringify([report.id, index])));
          for (const key of selected) if (JSON.parse(key)[0] === report.id) assert(allowed.has(key), `${entry.target}: wrong occurrence of duplicate test name`);
        }
      }
      if (selected.size) for (const file of requirement.files) {
        assert([...selected].some(key => { const [id, index] = JSON.parse(key); return reports.find(report => report.id === id)!.tests[index].file === file; }), `${entry.target}: no reported tests for ${file}`);
      }
    }
    let status: MetadataTestResult["status"];
    if (!entry.results.length) {
      assert((entry.status === "not-run" || entry.status === "not-applicable") && entry.detail, `${entry.target}: needs report results or an explicit blocker`);
      assert(entry.status !== "not-applicable" || requirement.notApplicable, `${entry.target}: metadata does not permit not-applicable`);
      status = entry.status;
    } else {
      assert(!requirement.notApplicable, `${entry.target}: not-applicable metadata cannot claim execution`);
      status = aggregateStatuses(statuses);
      assert(status === entry.status, `${entry.target}: claimed ${String(entry.status)} contradicts report outcome ${status}`);
      if (status === "not-run") assert(entry.detail, `${entry.target}: explain skipped or incomplete execution`);
    }
    const expected = requirement.expectedStatus;
    results.push({ target: entry.target, label: requirement.label, status, results: entry.results as MetadataTestResult["results"],
      ...(entry.detail ? { detail: entry.detail as string } : {}),
      expectationMatched: expected === "passing" || expected === "failing" ? (status === "passing" || status === "failing" ? expected === status : null) : null,
    });
  }
  const missing = requirements.filter(requirement => !seen.has(requirement.target));
  assert(missing.length === 0, `missing results for ${missing.map(requirement => `${requirement.target} (${requirement.label})`).join(", ")}`);
  return results;
}
