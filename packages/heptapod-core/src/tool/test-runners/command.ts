import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { testCommand, type TestCommand, type TestRunnerAdapter } from "./types.js";

const DEPENDENCY_FILES = new Set([
  "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb",
  "pnpm-workspace.yaml", ".npmrc", ".yarnrc.yml",
  "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
]);

function packageHasTestScript(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return typeof manifest.scripts?.test === "string" && manifest.scripts.test.trim() !== "";
  } catch {
    return false;
  }
}

export function owningPackage(worktree: string, file: string): string {
  const root = resolve(worktree);
  let directory = dirname(resolve(root, file));
  while (directory === root || directory.startsWith(`${root}${sep}`)) {
    if (packageHasTestScript(directory)) return directory;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return root;
}

export function nodeTargetCommand(worktree: string, template: string[], files: string[], cwd: string): TestCommand {
  const packageFiles = files.map(file => relative(cwd, resolve(worktree, file)).split(sep).join("/"));
  const argv = template.includes("{files}")
    ? template.flatMap(part => part === "{files}" ? packageFiles : [part])
    : [...template, ...((template[0] === "npm" || template[0] === "bun") && !template.includes("--") ? ["--"] : []), ...packageFiles];
  return testCommand(argv, cwd);
}

function detectNodeCommand(worktree: string): { command: string[]; setup: TestCommand[] } | null {
  const packagePath = join(worktree, "package.json");
  if (!existsSync(packagePath)) return null;
  let packageJson: { packageManager?: unknown; scripts?: Record<string, unknown> };
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as typeof packageJson;
  } catch {
    return null;
  }
  if (typeof packageJson.scripts?.test !== "string" || packageJson.scripts.test.trim() === "") return null;
  const declaredManager = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.split("@")[0]
    : null;
  const manager = declaredManager
    ?? (existsSync(join(worktree, "pnpm-lock.yaml")) ? "pnpm"
      : existsSync(join(worktree, "yarn.lock")) ? "yarn"
        : existsSync(join(worktree, "bun.lockb")) || existsSync(join(worktree, "bun.lock")) ? "bun"
          : "npm");
  const declaredVersion = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.split("@")[1]
    : null;
  const install = manager === "pnpm" && existsSync(join(worktree, "pnpm-lock.yaml"))
    ? { executable: "pnpm", args: ["install", "--frozen-lockfile"], display: "pnpm install --frozen-lockfile" }
    : manager === "npm" && existsSync(join(worktree, "package-lock.json"))
      ? { executable: "npm", args: ["ci"], display: "npm ci" }
      : manager === "yarn" && existsSync(join(worktree, "yarn.lock"))
        ? {
          executable: "yarn",
          args: ["install", declaredVersion?.startsWith("1.") ? "--frozen-lockfile" : "--immutable"],
          display: `yarn install ${declaredVersion?.startsWith("1.") ? "--frozen-lockfile" : "--immutable"}`,
        }
        : manager === "bun" && (existsSync(join(worktree, "bun.lockb")) || existsSync(join(worktree, "bun.lock")))
          ? { executable: "bun", args: ["install", "--frozen-lockfile"], display: "bun install --frozen-lockfile" }
          : undefined;
  return {
    command: [manager, "test"],
    setup: [install].filter((command): command is TestCommand => command !== undefined),
  };
}

export const commandRunner: TestRunnerAdapter = {
  detect(worktree) {
    const node = detectNodeCommand(worktree);
    if (node) return node;
    if (existsSync(join(worktree, "Cargo.toml"))) return { command: ["cargo", "test"], setup: [], targeted: false };
    if (existsSync(join(worktree, "go.mod"))) return { command: ["go", "test", "./..."], setup: [], targeted: false };
    return null;
  },
  dependenciesChanged: (paths) => paths.some((path) => DEPENDENCY_FILES.has(basename(path))),
  requiresRebuild: (paths) => paths.length > 0,
  fullCommand(template) {
    const argv = template.filter((part) => part !== "{files}");
    if (argv.at(-1) === "--") argv.pop();
    return testCommand(argv);
  },
  target(worktree, template, file) {
    const cwd = owningPackage(worktree, file);
    return { file, command: nodeTargetCommand(worktree, template, [file], cwd) };
  },
  parseResult: () => ({ failures: [] }),
};
