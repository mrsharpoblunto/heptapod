import { commandRunner } from "./command.js";
import type { TestRunnerAdapter } from "./types.js";

/** Vitest console reporters, including output prefixed by pnpm recursive scripts. */
export const vitestRunner: TestRunnerAdapter = {
  ...commandRunner,
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
