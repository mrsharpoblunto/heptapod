import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commandRunner } from "./command.js";
import { parseTestCases } from "../test-fixtures/index.js";
import { testCommand, type FixtureTestResult, type TestBatchCommand, type TestRunnerAdapter } from "./types.js";

function fixtureSelectors(worktree: string, file: string, format: Parameters<TestRunnerAdapter["target"]>[3]): string[] {
  return [...new Set(parseTestCases(readFileSync(resolve(worktree, file), "utf8"), file, format).flatMap(test => test.selectors ?? []))];
}

function matchesSelector(name: string, selector: string): boolean {
  return new RegExp(`^${selector.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);
}

export const googletestRunner: TestRunnerAdapter = {
  dependenciesChanged: commandRunner.dependenciesChanged,
  requiresRebuild: (paths) => paths.length > 0,
  validateCommand(template) {
    if (template.some((part) => part === "{files}" || part.startsWith("--gtest_filter"))) {
      throw new Error("the googletest runner supplies its own test filters; omit {files} and --gtest_filter.");
    }
  },
  fullCommand: (template) => testCommand([...template, "--gtest_color=no", "--gtest_print_time=1", "--gtest_filter=*"]),
  target(worktree, template, file, format) {
    const selectors = fixtureSelectors(worktree, file, format);
    if (selectors.length === 0) {
      return { file, command: null, detail: "No GoogleTest selectors could be read from this fixture." };
    }
    return { file, command: testCommand([
      ...template, "--gtest_color=no", `--gtest_filter=${selectors.join(":")}`,
    ], worktree) };
  },
  batch(worktree, template, files, format) {
    const batches: TestBatchCommand[] = [];
    let selectedFiles: string[] = [], selectors: string[] = [];
    const flush = () => {
      if (!selectedFiles.length) return;
      batches.push({ files: selectedFiles, command: testCommand([...template, "--gtest_color=no", "--gtest_print_time=1", `--gtest_filter=${[...new Set(selectors)].join(":")}`], worktree) });
      selectedFiles = []; selectors = [];
    };
    for (const file of files) {
      const selected = fixtureSelectors(worktree, file, format);
      if (!selected.length) { batches.push({ files: [file], command: null, detail: "No GoogleTest selectors could be read from this fixture." }); continue; }
      if (selectedFiles.length >= 100 || selectors.join(":").length + selected.join(":").length > 32_000) flush();
      selectedFiles.push(file); selectors.push(...selected);
    }
    flush();
    return batches;
  },
  parseBatchResult(output, _command, files, worktree, format) {
    const completed = [...output.matchAll(/^\s*\[\s*(OK|FAILED|SKIPPED)\s*\]\s+(\S+\.\S+).*?\((\d+) ms\)\s*$/gm)];
    const results: Record<string, FixtureTestResult> = {};
    for (const file of files) {
      const selectors = fixtureSelectors(worktree, file, format);
      const tests = completed.filter(test => selectors.some(selector => matchesSelector(test[2], selector)));
      if (!tests.length) continue;
      const failures = [...new Set(tests.filter(test => test[1] === "FAILED").map(test => test[2]))];
      const ran = tests.some(test => test[1] !== "SKIPPED");
      results[file] = { status: failures.length ? "failing" : ran ? "passing" : "not-run", failures,
        durationMs: tests.reduce((total, test) => total + Number(test[3]), 0),
        ...(!ran ? { detail: "GoogleTest skipped all tests in this fixture." } : {}) };
    }
    return results;
  },
  parseResult(output) {
    const failures = [...new Set([...output.matchAll(/^\s*\[\s*FAILED\s*\]\s+([^\s]+\.[^\s]+)/gm)]
      .map((match) => match[1]))].slice(0, 100);
    if (/\[==========\]\s+Running 0 tests?\b/.test(output)) return { failures, error: "GoogleTest ran no tests." };
    if (!/\[==========\]\s+\d+ tests? from .+ ran\./.test(output)) {
      return { failures, error: "GoogleTest did not report a completed test run." };
    }
    return { failures };
  },
};
