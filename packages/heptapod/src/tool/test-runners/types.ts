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
  fullCommand(template: string[]): TestCommand;
  target(worktree: string, template: string[], file: string, format: FixtureFormat): TargetedTestCommand;
  failures(output: string): string[];
  resultError?(output: string): string | undefined;
}

export function testCommand(argv: string[], cwd?: string): TestCommand {
  const [executable, ...args] = argv;
  return { executable, args, display: argv.join(" "), ...(cwd ? { cwd } : {}) };
}
