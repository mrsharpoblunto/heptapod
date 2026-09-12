import type { FixtureFormat } from "../test-fixtures/index.js";

export interface TestCommand {
  executable: string;
  args: string[];
  display: string;
  cwd?: string;
}

export interface TargetedTestCommand {
  file: string;
  command: TestCommand | null;
  detail?: string;
}

export interface TestRunnerAdapter {
  detect?(worktree: string): { command: string[]; setup: TestCommand[]; targeted?: boolean } | null;
  dependenciesChanged?(paths: string[]): boolean;
  validateCommand?(template: string[]): void;
  fullCommand(template: string[]): TestCommand;
  target(worktree: string, template: string[], file: string, format: FixtureFormat): TargetedTestCommand;
  parseResult(output: string): TestResult;
}

export interface TestResult {
  failures: string[];
  error?: string;
}

export function testCommand(argv: string[], cwd?: string): TestCommand {
  const [executable, ...args] = argv;
  return { executable, args, display: argv.join(" "), ...(cwd ? { cwd } : {}) };
}
