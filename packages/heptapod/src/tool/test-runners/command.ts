import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { testCommand, type TestRunnerAdapter } from "./types.js";

export function extractObservedFailures(output: string): string[] {
  const failures = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^(?:FAIL(?:ED)?|ERROR)\s+(.+)$/i)
      ?? line.match(/^(?:×|✕|✖|✗)\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/)
      ?? line.match(/^not ok(?:\s+\d+)?\s*[-:]\s*(.+)$/i);
    const failure = match?.[1]?.trim();
    if (failure) failures.add(failure);
    if (failures.size >= 100) break;
  }
  return [...failures];
}

function packageHasTestScript(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return typeof manifest.scripts?.test === "string" && manifest.scripts.test.trim() !== "";
  } catch {
    return false;
  }
}

function owningPackage(worktree: string, file: string): string {
  const root = resolve(worktree);
  let directory = dirname(resolve(root, file));
  while (directory === root || directory.startsWith(`${root}${sep}`)) {
    if (packageHasTestScript(directory)) return directory;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return root;
}

export const commandRunner: TestRunnerAdapter = {
  fullCommand(template) {
    const argv = template.filter((part) => part !== "{files}");
    if (argv.at(-1) === "--") argv.pop();
    return testCommand(argv);
  },
  target(worktree, template, file) {
    const cwd = owningPackage(worktree, file);
    const packageFile = relative(cwd, resolve(worktree, file)).split(sep).join("/");
    const argv = template.includes("{files}")
      ? template.flatMap((part) => part === "{files}" ? [packageFile] : [part])
      : [...template, ...(template[0] === "npm" || template[0] === "bun" ? ["--"] : []), packageFile];
    return { file, command: testCommand(argv, cwd) };
  },
  failures: extractObservedFailures,
};
