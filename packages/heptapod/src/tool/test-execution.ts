import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { loadHeptapodConfig, type HeptapodConfig } from "./config.js";
import { readArtifact } from "./manifest.js";
import { run } from "./process.js";
import type {
  ExpectedTestStatus,
  NarrativeManifest,
  NarrativeStep,
  StepTestRun,
  TestAreaChange,
  TestExecutionMetadata,
  TestFixtureRun,
} from "./types.js";

interface TestCommand {
  executable: string;
  args: string[];
  display: string;
  cwd?: string;
}

interface TestPlan {
  full: TestCommand;
  setup: TestCommand[];
  nodeManager?: string;
  runnerTemplate?: string[];
}

export interface NarrativeTestExecution {
  metadata: TestExecutionMetadata;
  runsByStep: Map<string, StepTestRun>;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const OUTPUT_LIMIT = 200_000;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function configuredTestPlan(config: HeptapodConfig | null, inferred: TestPlan | null): TestPlan | null {
  const runner = config?.test?.runner?.command;
  if (!runner && !inferred) return null;
  const [executable, ...args] = runner ?? [inferred?.full.executable ?? "", ...(inferred?.full.args ?? [])];
  if (!executable) return null;
  const fullArgs = args.filter((part) => part !== "{files}");
  if (runner && fullArgs.at(-1) === "--") fullArgs.pop();
  const configuredPrerequisites = config?.test?.prerequisites;
  return {
    full: { executable, args: fullArgs, display: [executable, ...fullArgs].join(" ") },
    setup: configuredPrerequisites?.map(({ command }) => {
      const [setupExecutable, ...setupArgs] = command;
      if (!setupExecutable) throw new Error("Invalid .heptapod.json: prerequisite command cannot be empty.");
      return { executable: setupExecutable, args: setupArgs, display: command.join(" ") };
    }) ?? inferred?.setup ?? [],
    nodeManager: runner ? executable : inferred?.nodeManager,
    runnerTemplate: runner ?? inferred?.runnerTemplate,
  };
}

function detectNodeTestPlan(worktree: string): TestPlan | null {
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
    full: { executable: manager, args: ["test"], display: `${manager} test` },
    setup: [install].filter((command): command is TestCommand => command !== undefined),
    nodeManager: manager,
    runnerTemplate: [manager, "test"],
  };
}

function detectTestPlan(worktree: string, config: HeptapodConfig | null): TestPlan | null {
  let inferred = detectNodeTestPlan(worktree);
  if (existsSync(join(worktree, "Cargo.toml"))) {
    inferred ??= { full: { executable: "cargo", args: ["test"], display: "cargo test" }, setup: [] };
  }
  if (existsSync(join(worktree, "go.mod"))) {
    inferred ??= { full: { executable: "go", args: ["test", "./..."], display: "go test ./..." }, setup: [] };
  }
  return configuredTestPlan(config, inferred);
}

function expectedStatus(step: NarrativeStep): ExpectedTestStatus {
  if (step.checks.automated.some((check) => check.status === "failing")) return "failing";
  const comparable = step.checks.automated.filter((check) => check.status !== "not-applicable");
  if (comparable.length > 0 && comparable.every((check) => check.status === "passing")) return "passing";
  return "not-specified";
}

function normalizeFailure(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function extractObservedFailures(output: string): string[] {
  const failures = new Set<string>();
  for (const rawLine of output.replace(ANSI_ESCAPE, "").split("\n")) {
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

function buildStepTestRun(
  command: string,
  result: CommandResult,
  step: NarrativeStep,
  scope: StepTestRun["scope"],
  files: string[],
  fixtureRuns: TestFixtureRun[] = [],
): StepTestRun {
  const expected = expectedStatus(step);
  const expectedFailures = step.checks.automated
    .filter((check) => check.status === "failing")
    .map((check) => check.label);
  const observedFailures = extractObservedFailures(result.output);
  const normalizedExpected = expectedFailures.map(normalizeFailure).filter(Boolean);
  const unexpectedFailures = result.status === "failing" && expected === "failing"
    ? []
    : observedFailures.filter((failure) => {
      const normalized = normalizeFailure(failure);
      return !normalizedExpected.some((expectedFailure) => (
        normalized.includes(expectedFailure) || expectedFailure.includes(normalized)
      ));
    });
  if (result.status !== "passing" && observedFailures.length === 0 && expectedFailures.length === 0) {
    unexpectedFailures.push(`Test command exited with ${result.status === "timed-out" ? "a timeout" : `code ${result.exitCode ?? "unknown"}`}.`);
  }
  const observedComparable = result.status === "passing" || result.status === "failing" ? result.status : null;
  return {
    command,
    scope,
    files,
    status: result.status,
    expectedStatus: expected,
    expectationMatched: expected === "not-specified" || observedComparable === null
      ? null
      : observedComparable === expected && unexpectedFailures.length === 0,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    expectedFailures,
    observedFailures,
    unexpectedFailures,
    fixtureRuns,
    output: result.output,
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

function skippedRun(step: NarrativeStep, detail: string, files: string[] = [], output = ""): StepTestRun {
  return {
    command: null,
    scope: "changed-tests",
    files,
    status: "not-run",
    expectedStatus: expectedStatus(step),
    expectationMatched: null,
    exitCode: null,
    durationMs: 0,
    expectedFailures: step.checks.automated
      .filter((check) => check.status === "failing")
      .map((check) => check.label),
    observedFailures: [],
    unexpectedFailures: [],
    fixtureRuns: [],
    output,
    detail,
  };
}

interface CommandResult {
  status: "passing" | "failing" | "timed-out";
  exitCode: number | null;
  durationMs: number;
  output: string;
  detail?: string;
}

function executeCommand(command: TestCommand, worktree: string, timeoutMs: number): CommandResult {
  const started = Date.now();
  const result = spawnSync(command.executable, command.args, {
    cwd: command.cwd ?? worktree,
    encoding: "utf8",
    env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const output = `${result.stdout ?? ""}${result.stderr ? `${result.stdout ? "\n" : ""}${result.stderr}` : ""}`
    .replace(ANSI_ESCAPE, "")
    .slice(-OUTPUT_LIMIT);
  const timedOut = result.error && "code" in result.error && result.error.code === "ETIMEDOUT";
  return {
    status: timedOut ? "timed-out" : result.status === 0 ? "passing" : "failing",
    exitCode: result.status,
    durationMs: Date.now() - started,
    output,
    ...(result.error ? { detail: result.error.message } : {}),
  };
}

function combineCommandResults(results: Array<{ command: TestCommand; result: CommandResult }>): CommandResult & { command: string } {
  const status = results.some(({ result }) => result.status === "timed-out")
    ? "timed-out"
    : results.every(({ result }) => result.status === "passing")
      ? "passing"
      : "failing";
  return {
    command: results.map(({ command }) => command.display).join(" && "),
    status,
    exitCode: results.find(({ result }) => result.status !== "passing")?.result.exitCode ?? 0,
    durationMs: results.reduce((total, { result }) => total + result.durationMs, 0),
    output: results.map(({ command, result }) => `$ ${command.display}\n${result.output}`).join("\n\n"),
    detail: results.find(({ result }) => result.detail)?.result.detail,
  };
}

function buildFixtureRun(file: string, command: TestCommand, result: CommandResult, step: NarrativeStep): TestFixtureRun {
  const run = buildStepTestRun(command.display, result, step, "changed-tests", [file]);
  return {
    file,
    command: command.display,
    status: run.status,
    expectedStatus: run.expectedStatus,
    expectationMatched: run.expectationMatched,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    observedFailures: run.observedFailures,
    unexpectedFailures: run.unexpectedFailures,
    output: run.output,
    ...(run.detail ? { detail: run.detail } : {}),
  };
}

function skippedFixtureRun(file: string, step: NarrativeStep, detail: string, output = ""): TestFixtureRun {
  const run = skippedRun(step, detail, [file], output);
  return {
    file,
    command: "",
    status: run.status,
    expectedStatus: run.expectedStatus,
    expectationMatched: run.expectationMatched,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    observedFailures: [],
    unexpectedFailures: [],
    output,
    detail,
  };
}

function packageHasTestScript(directory: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return typeof packageJson.scripts?.test === "string" && packageJson.scripts.test.trim() !== "";
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

function targetedCommands(worktree: string, plan: TestPlan, files: string[]): Array<{ file: string; command: TestCommand }> {
  if (!plan.nodeManager || !plan.runnerTemplate) return [];
  const commands: Array<{ file: string; command: TestCommand }> = [];
  for (const file of files) {
    if (!existsSync(resolve(worktree, file))) continue;
    const packageDirectory = owningPackage(worktree, file);
    const packageFile = relative(packageDirectory, resolve(worktree, file)).split(sep).join("/");
    const [executable, ...configuredArgs] = plan.runnerTemplate ?? [];
    if (!executable) throw new Error("The configured test runner command is empty.");
    const hasPlaceholder = configuredArgs.includes("{files}");
    const args = hasPlaceholder
      ? configuredArgs.flatMap((argument) => argument === "{files}" ? [packageFile] : [argument])
      : [...configuredArgs, ...(plan.nodeManager === "npm" || plan.nodeManager === "bun" ? ["--"] : []), packageFile];
    const command = {
      executable,
      args,
      display: [executable, ...args].join(" "),
      cwd: packageDirectory,
    };
    commands.push({ file, command });
  }
  return commands;
}

function changesDependencies(step: NarrativeStep, manifestPath: string): boolean {
  if (!step.diff) return false;
  const patch = readArtifact(manifestPath, step.diff).toString("utf8");
  return /^diff --git a\/(?:.+\/)?(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum) b\//m.test(patch);
}

function configuredTimeout(): number {
  const configured = Number(process.env.HEPTAPOD_TEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

export function executeNarrativeTests(
  repo: string,
  manifest: NarrativeManifest,
  manifestPath: string,
  onProgress: (message: string) => void = () => {},
  testAreasByStep: Map<string, TestAreaChange[]> = new Map(),
): NarrativeTestExecution {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "heptapod-ingest-"));
  const worktree = join(temporaryRoot, "worktree");
  let registered = false;
  const timeoutMs = configuredTimeout();
  const config = loadHeptapodConfig(repo);
  try {
    onProgress(`Creating temporary test worktree at ${worktree}`);
    run("git", ["worktree", "add", "--detach", worktree, manifest.source.base], { cwd: repo });
    registered = true;
    const plan = detectTestPlan(worktree, config);
    const runsByStep = new Map<string, StepTestRun>();
    if (!plan) {
      for (const step of manifest.steps) {
        runsByStep.set(step.id, skippedRun(step, "No supported project test command was detected."));
      }
      return { metadata: { command: null, worktreeBase: manifest.source.base, timeoutMs }, runsByStep };
    }

    let dependenciesReady = true;
    let setupFailure: CommandResult | null = null;
    for (const setup of plan.setup) {
      onProgress(`Preparing the test worktree with ${setup.display}`);
      setupFailure = executeCommand(setup, worktree, timeoutMs);
      dependenciesReady = setupFailure.status === "passing";
      if (!dependenciesReady) break;
    }

    const changedTestFiles = new Set<string>();
    for (const [index, step] of manifest.steps.entries()) {
      if (step.diff) {
        run("git", ["apply", "--index", "--binary", "--whitespace=nowarn", "--recount", "-"], {
          cwd: worktree,
          input: readArtifact(manifestPath, step.diff),
        });
      }
      for (const area of testAreasByStep.get(step.id) ?? []) {
        for (const file of area.files) changedTestFiles.add(file.path);
      }
      if (plan.setup.length > 0 && changesDependencies(step, manifestPath)) {
        onProgress(`Refreshing dependencies after step ${index + 1}/${manifest.steps.length}`);
        for (const setup of plan.setup) {
          setupFailure = executeCommand(setup, worktree, timeoutMs);
          dependenciesReady = setupFailure.status === "passing";
          if (!dependenciesReady) break;
        }
      }
      const finalStep = index === manifest.steps.length - 1;
      const files = [...changedTestFiles];
      const fixtureCommands = targetedCommands(worktree, plan, files);
      if (!dependenciesReady) {
        const detail = `${plan.setup.at(-1)?.display ?? "Test preparation"} failed; tests were not run.`;
        const run = skippedRun(
          step,
          detail,
          files,
          setupFailure?.output,
        );
        run.fixtureRuns = files.map((file) => skippedFixtureRun(file, step, detail, setupFailure?.output));
        runsByStep.set(step.id, run);
      } else {
        const executedFixtures = fixtureCommands.map(({ file, command }, fixtureIndex) => {
          onProgress(`Running test file ${fixtureIndex + 1}/${fixtureCommands.length} after step ${index + 1}/${manifest.steps.length}: ${file}`);
          const result = executeCommand(command, worktree, timeoutMs);
          return { file, command, result };
        });
        const fixtureRuns = executedFixtures.map(({ file, command, result }) => buildFixtureRun(file, command, result, step));
        if (finalStep) {
          onProgress(`Running the full ${plan.full.display} suite after step ${index + 1}/${manifest.steps.length}: ${step.title}`);
          const result = executeCommand(plan.full, worktree, timeoutMs);
          runsByStep.set(step.id, buildStepTestRun(plan.full.display, result, step, "full-suite", files, fixtureRuns));
        } else if (executedFixtures.length === 0) {
          onProgress(`No changed test files to run after step ${index + 1}/${manifest.steps.length}: ${step.title}`);
          runsByStep.set(step.id, skippedRun(step, "No changed test files have been introduced by this step.", files));
        } else {
          const result = combineCommandResults(executedFixtures);
          runsByStep.set(step.id, buildStepTestRun(result.command, result, step, "changed-tests", files, fixtureRuns));
        }
      }
      run("git", ["checkout-index", "-a", "-f"], { cwd: worktree });
    }

    return {
      metadata: {
        command: plan.full.display,
        worktreeBase: manifest.source.base,
        timeoutMs,
        ...(plan.setup.length > 0 ? { dependencySource: plan.setup.map((command) => command.display).join("; ") } : {}),
      },
      runsByStep,
    };
  } finally {
    if (registered) {
      run("git", ["worktree", "remove", "--force", worktree], { cwd: repo, allowFailure: true });
      run("git", ["worktree", "prune"], { cwd: repo, allowFailure: true });
    }
    if (existsSync(temporaryRoot) && lstatSync(temporaryRoot).isDirectory()) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}
