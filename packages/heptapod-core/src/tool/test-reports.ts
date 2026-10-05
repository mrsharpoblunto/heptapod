import { posix, win32 } from "node:path";
import type { ObservedTestStatus } from "./types.js";

export interface ReportedTest { file: string; name: string; status: "passing" | "failing" | "not-run"; durationMs: number; failures: string[] }
export interface TestReport {
  id: string; path: string; format: string; command: string; exitCode: number | null;
  status: ObservedTestStatus; tests: ReportedTest[]; output: string; failures: string[];
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid test report: ${message}`);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected an object");
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function duration(value: unknown): number {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0, "duration must be nonnegative"); return value;
}
function strings(value: unknown): string[] {
  assert(Array.isArray(value) && value.every(item => typeof item === "string"), "failure messages must be strings"); return value;
}
function filePath(value: unknown, root: string): string {
  assert(text(value), "test file is required");
  const paths = /^[A-Za-z]:[\\/]/.test(root) ? win32 : posix;
  assert(paths.isAbsolute(root), "root must identify the absolute tested checkout");
  const file = paths.relative(root, paths.resolve(root, value)).replaceAll("\\", "/");
  assert(file && file !== ".." && !file.startsWith("../") && !paths.isAbsolute(file), `file leaves tested checkout: ${value}`);
  return file;
}

/** Read native runner output; never infer individual tests from a command's exit code. */
export function readTestReport(value: unknown, read: (path: string) => string): TestReport {
  object(value);
  assert(text(value.id) && text(value.path) && text(value.command) && text(value.log), "id, path, command, and log are required");
  assert(value.exitCode === null || (Number.isInteger(value.exitCode) && Number(value.exitCode) >= 0), "invalid exitCode");
  const raw: unknown = JSON.parse(read(value.path)); object(raw);
  const output = read(value.log);
  const tests: ReportedTest[] = [];
  const errors: string[] = [];
  let timedOut = false;
  if (value.format === "command") {
    assert(raw.command === value.command && raw.exitCode === value.exitCode && raw.output === output, "command receipt contradicts command, exit code, or log");
    duration(raw.durationMs);
    assert(typeof raw.timedOut === "boolean", "command receipt needs timedOut");
    timedOut = raw.timedOut;
    assert(!timedOut || value.exitCode === null, "timed-out receipt must have null exitCode");
  } else {
    assert(text(value.root), "native test reports need the tested checkout root");
    if (value.format === "vitest") {
      assert(Array.isArray(raw.testResults) && typeof raw.success === "boolean", "Vitest report needs testResults and success");
      for (const suite of raw.testResults) {
        object(suite);
        const file = filePath(suite.name, value.root);
        assert(Array.isArray(suite.assertionResults), "Vitest suite needs assertionResults");
        assert(["passed", "failed", "pending", "skipped", "todo"].includes(String(suite.status)), "unknown Vitest suite status");
        for (const test of suite.assertionResults) {
          object(test);
          assert(text(test.fullName) && ["passed", "failed", "pending", "skipped", "todo", "disabled"].includes(String(test.status)), "invalid Vitest assertion");
          const failures = strings(test.failureMessages ?? []);
          assert(test.status === "failed" || failures.length === 0, "non-failing assertion has failure messages");
          tests.push({ file, name: test.fullName.trim(), status: test.status === "passed" ? "passing" : test.status === "failed" ? "failing" : "not-run", durationMs: duration(test.duration ?? 0), failures });
        }
        if (suite.status === "failed" && !suite.assertionResults.some(test => test.status === "failed")) errors.push(`${file}: ${suite.message || "suite failed before completing tests"}`);
      }
      assert(raw.numTotalTests === tests.length && raw.numFailedTests === tests.filter(test => test.status === "failing").length
        && raw.numPassedTests === tests.filter(test => test.status === "passing").length, "Vitest summary counts do not match its assertions");
      if (!raw.success && !errors.length && !tests.some(test => test.status === "failing")) errors.push("Vitest reported an unsuccessful run");
      assert(!raw.success || (!errors.length && tests.every(test => test.status !== "failing")), "Vitest success contradicts failures");
    } else if (value.format === "googletest") {
      assert(Array.isArray(raw.testsuites), "GoogleTest report needs testsuites");
      for (const suite of raw.testsuites) {
        object(suite); assert(text(suite.name) && Array.isArray(suite.testsuite), "invalid GoogleTest suite");
        for (const test of suite.testsuite) {
          object(test); assert(text(test.name) && ["RUN", "NOTRUN"].includes(String(test.status)), "invalid GoogleTest test");
          assert(test.result === undefined || ["COMPLETED", "SKIPPED", "SUPPRESSED"].includes(String(test.result)), "unknown GoogleTest result");
          assert(test.failures === undefined || Array.isArray(test.failures), "invalid GoogleTest failures");
          const failures = (test.failures ?? []).map((failure: unknown) => {
            object(failure); assert(text(failure.failure ?? failure.message), "missing GoogleTest failure message"); return String(failure.failure ?? failure.message);
          });
          const seconds = typeof test.time === "string" && /^\d+(?:\.\d+)?s$/.test(test.time) ? Number(test.time.slice(0, -1)) : NaN;
          tests.push({ file: filePath(test.file, value.root), name: `${suite.name}.${test.name}`,
            status: failures.length ? "failing" : test.status === "NOTRUN" || test.result === "SKIPPED" || test.result === "SUPPRESSED" ? "not-run" : "passing",
            durationMs: duration(seconds * 1000), failures });
        }
        if (Number(suite.errors ?? 0) > 0) errors.push(`${suite.name}: GoogleTest suite errors`);
      }
      assert(raw.tests === tests.length && raw.failures === tests.filter(test => test.status === "failing").length, "GoogleTest summary counts do not match its tests");
      if (Number(raw.errors ?? 0) > 0) errors.push("GoogleTest reported errors");
    } else throw new Error(`Unsupported test report format: ${String(value.format)}`);
    assert(tests.length > 0 || errors.length > 0, "empty test report cannot establish a result");
  }
  const failures = [...tests.filter(test => test.status === "failing").map(test => `${test.file} > ${test.name}`), ...errors];
  if (!failures.length && (timedOut || value.exitCode !== 0)) {
    failures.push(`${value.command}: ${timedOut ? "timed out" : `exited with ${value.exitCode ?? "no exit code"}`}`);
  }
  const status = timedOut ? "timed-out" : value.exitCode !== 0 || failures.length ? "failing" :
    value.format === "command" || tests.some(test => test.status === "passing") ? "passing" : "not-run";
  return { id: value.id, path: value.path, format: String(value.format), command: value.command, exitCode: value.exitCode as number | null, status, tests, output, failures };
}
