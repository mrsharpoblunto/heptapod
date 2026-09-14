import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { commandRunner, nodeTargetCommand, owningPackage } from "./command.js";
import { testCommand, type FixtureTestResult, type TestBatchCommand, type TestRunnerAdapter } from "./types.js";

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Vitest console reporters, including output prefixed by pnpm recursive scripts. */
export const vitestRunner: TestRunnerAdapter = {
  ...commandRunner,
  fullCommand(template, resultDirectory) {
    const command = commandRunner.fullCommand(template);
    if (!resultDirectory) return command;
    const resultFile = join(resultDirectory, `${randomUUID()}.json`);
    const separator = ["npm", "bun"].includes(command.executable) && !command.args.includes("--") ? ["--"] : [];
    return { ...testCommand([command.executable, ...command.args, ...separator,
      "--reporter=default", "--reporter=json", `--outputFile.json=${resultFile}`]), resultFile };
  },
  requiresRebuild: (paths) => commandRunner.dependenciesChanged!(paths),
  batch(worktree, template, files, _format, resultDirectory) {
    const packages = new Map<string, string[]>();
    for (const file of files) {
      const cwd = owningPackage(worktree, file);
      const group = packages.get(cwd) ?? [];
      group.push(file); packages.set(cwd, group);
    }
    const batches: TestBatchCommand[] = [];
    for (const [cwd, packageFiles] of packages) {
      for (let start = 0; start < packageFiles.length; start += 100) {
        const files = packageFiles.slice(start, start + 100);
        const command = nodeTargetCommand(worktree, template, files, cwd);
        const resultFile = join(resultDirectory, `${randomUUID()}.json`);
        batches.push({ files, command: { ...testCommand([command.executable, ...command.args,
          "--reporter=default", "--reporter=json", `--outputFile.json=${resultFile}`], cwd), resultFile } });
      }
    }
    return batches;
  },
  parseBatchResult(_output, command, files, worktree) {
    const report = JSON.parse(readFileSync(command.resultFile!, "utf8")) as { testResults?: Array<{
      name: string; status: string; message?: string; startTime?: number; endTime?: number;
      assertionResults?: Array<{ status: string; fullName: string; failureMessages?: string[] }>;
    }> };
    if (!Array.isArray(report.testResults)) throw new Error("Vitest JSON report has no testResults array.");
    const byPath = new Map<string, typeof report.testResults>();
    for (const suite of report.testResults) {
      if (typeof suite.name !== "string") continue;
      const path = canonicalPath(resolve(command.cwd ?? worktree, suite.name));
      const suites = byPath.get(path) ?? [];
      suites.push(suite); byPath.set(path, suites);
    }
    const results: Record<string, FixtureTestResult> = {};
    for (const file of files) {
      const suites = byPath.get(canonicalPath(resolve(worktree, file))) ?? [];
      if (!suites.length) continue;
      const assertions = suites.flatMap(suite => suite.assertionResults ?? []);
      const failures = assertions.filter(test => test.status === "failed").map(test => `${file} > ${test.fullName}`);
      const failed = suites.some(suite => suite.status === "failed") || failures.length > 0;
      const ran = assertions.some(test => test.status === "passed" || test.status === "failed");
      const detail = suites.map(suite => suite.message).filter(Boolean).join("\n");
      results[file] = {
        status: failed ? "failing" : ran && suites.every(suite => suite.status === "passed") ? "passing" : "not-run",
        failures: failed && !failures.length ? [file] : failures,
        durationMs: suites.reduce((total, suite) => total + Math.max(0, (suite.endTime ?? 0) - (suite.startTime ?? 0)), 0),
        ...(detail ? { detail } : !ran && !failed ? { detail: "Vitest did not execute any tests in this fixture (it may be skipped)." } : {}),
      };
    }
    return results;
  },
  parseResult(output) {
    const failures = new Set<string>();
    let failureSection = false;
    const lines = output.split("\n").map((line) => line.replace(/^\S.*? test:\s*/, "").trim());
    for (const line of lines) {
      if (/^⎯+\s+Failed (?:Tests|Suites)\b/.test(line)) failureSection = true;
      if (/^Test Files\s/.test(line)) failureSection = false;
      const failure = failureSection ? line.match(/^FAIL\s+(.+)$/)?.[1] : undefined;
      if (failure && failures.size < 100) failures.add(failure);
    }
    const result = { failures: [...failures] };
    if (lines.some((line) => /^No test files found\b/.test(line) || /^Tests\s+no tests\b/.test(line))) {
      return { ...result, error: "Vitest ran no tests." };
    }
    if (lines.some((line) => /^Vitest caught [1-9]\d* unhandled errors?\b/.test(line))) {
      return { ...result, error: "Vitest reported unhandled errors." };
    }
    if (!lines.some((line) => /^Test Files\s+\d+/.test(line)) || !lines.some((line) => /^Tests\s+\d+/.test(line))) {
      return { ...result, error: "Vitest did not report a completed test run. Use a Vitest console reporter." };
    }
    if (!failures.size && lines.some((line) => /^(?:Test Files|Tests)\s+.*\b[1-9]\d* failed\b/.test(line))) {
      return { ...result, error: "Vitest reported failing tests or suites." };
    }
    return result;
  },
};
