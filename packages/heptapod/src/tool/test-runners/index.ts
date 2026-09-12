import { commandRunner } from "./command.js";
import { googletestRunner } from "./googletest.js";
import type { TestRunnerAdapter } from "./types.js";

export const runnerAdapters = {
  command: commandRunner,
  googletest: googletestRunner,
} satisfies Record<string, TestRunnerAdapter>;

export type RunnerFormat = keyof typeof runnerAdapters;
