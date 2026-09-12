import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTestCases } from "../test-fixtures/index.js";
import { testCommand, type TestRunnerAdapter } from "./types.js";

export const googletestRunner: TestRunnerAdapter = {
  fullCommand: (template) => testCommand([...template, "--gtest_color=no", "--gtest_filter=*"]),
  target(worktree, template, file, format) {
    const cases = parseTestCases(readFileSync(resolve(worktree, file), "utf8"), file, format);
    const selectors = [...new Set(cases.flatMap((testCase) => testCase.selectors ?? []))];
    if (selectors.length === 0) {
      return { file, command: null, detail: "No GoogleTest selectors could be read from this fixture." };
    }
    return { file, command: testCommand([
      ...template, "--gtest_color=no", `--gtest_filter=${selectors.join(":")}`,
    ], worktree) };
  },
  failures(output) {
    return [...new Set([...output.matchAll(/^\s*\[\s*FAILED\s*\]\s+([^\s]+\.[^\s]+)/gm)]
      .map((match) => match[1]))].slice(0, 100);
  },
  resultError(output) {
    if (/\[==========\]\s+Running 0 tests?\b/.test(output)) return "GoogleTest ran no tests.";
    if (!/\[==========\]\s+\d+ tests? from .+ ran\./.test(output)) {
      return "GoogleTest did not report a completed test run.";
    }
    return undefined;
  },
};
