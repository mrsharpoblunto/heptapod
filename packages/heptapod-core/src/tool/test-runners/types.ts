import type { FixtureFormat } from "../test-fixtures/index.js";

export interface TestCommand {
  executable: string;
  args: string[];
  display: string;
  cwd?: string;
  resultFile?: string;
}

export interface TestBatchCommand {
  files: string[];
  command: TestCommand | null;
  detail?: string;
}

export interface FixtureTestResult {
  status: "passing" | "failing" | "not-run";
  failures: string[];
  durationMs: number;
  detail?: string;
}

export interface TargetedTestCommand {
  file: string;
  command: TestCommand | null;
  detail?: string;
}

export interface TestRunnerAdapter {
  detect?(worktree: string): { command: string[]; setup: TestCommand[]; targeted?: boolean } | null;
  dependenciesChanged?(paths: string[]): boolean;
  requiresRebuild(pathsSinceBuild: string[]): boolean;
  validateCommand?(template: string[]): void;
  fullCommand(template: string[]): TestCommand;
  target(worktree: string, template: string[], file: string, format: FixtureFormat): TargetedTestCommand;
  batch?(worktree: string, template: string[], files: string[], format: FixtureFormat, resultDirectory: string): TestBatchCommand[];
  parseBatchResult?(output: string, command: TestCommand, files: string[], worktree: string, format: FixtureFormat): Record<string, FixtureTestResult>;
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
