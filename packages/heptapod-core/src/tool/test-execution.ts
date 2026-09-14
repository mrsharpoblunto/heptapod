import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { loadHeptapodConfig, type HeptapodConfig } from "./config.js";
import { type FixtureFormat } from "./test-fixtures/index.js";
import { runnerAdapters } from "./test-runners/index.js";
import { testCommand, type FixtureTestResult, type TestBatchCommand, type TestCommand, type TestRunnerAdapter } from "./test-runners/types.js";
import { readArtifact } from "./manifest.js";
import { patchRename, splitPatchFiles } from "./patch.js";
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

interface TestPlan {
  full: TestCommand;
  setup: TestCommand[];
  build: TestCommand[];
  adapter: TestRunnerAdapter;
  fixtureFormat: FixtureFormat;
  runnerTemplate?: string[];
  batch: boolean;
  rebuild: "auto" | "always" | "never";
}

export interface NarrativeTestExecution {
  metadata: TestExecutionMetadata;
  runsByStep: Map<string, StepTestRun>;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const OUTPUT_LIMIT = 200_000;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function detectTestPlan(worktree: string, config: HeptapodConfig | null, resultDirectory: string): TestPlan | null {
  const adapter = runnerAdapters[config?.test?.runner?.format ?? "command"];
  const inferred = adapter.detect?.(worktree);
  const template = config?.test?.runner?.command ?? inferred?.command;
  if (!template) return null;
  return {
    full: adapter.fullCommand(template, resultDirectory),
    setup: config?.test?.prerequisites?.map(({ command }) => testCommand(command)) ?? inferred?.setup ?? [],
    build: config?.test?.build?.map(({ command }) => testCommand(command)) ?? [],
    adapter,
    fixtureFormat: config?.test?.fixtures?.format ?? "auto",
    runnerTemplate: config?.test?.runner?.command ?? (inferred?.targeted === false ? undefined : template),
    batch: config?.test?.runner?.batch ?? Boolean(adapter.batch && adapter.parseBatchResult),
    rebuild: config?.test?.runner?.rebuild ?? "auto",
  };
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
  const observedFailures = result.observedFailures ?? [];
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
    unexpectedFailures.push(result.detail ?? `Test command exited with ${result.status === "timed-out" ? "a timeout" : `code ${result.exitCode ?? "unknown"}`}.`);
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
    output: result.output.slice(-OUTPUT_LIMIT),
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
    output: output.slice(-OUTPUT_LIMIT),
    detail,
  };
}

interface CommandResult {
  observedFailures?: string[];
  status: "passing" | "failing" | "timed-out";
  exitCode: number | null;
  durationMs: number;
  output: string;
  detail?: string;
  fixtures?: Record<string, FixtureTestResult>;
  batchError?: string;
}

function executeCommand(command: TestCommand, worktree: string, timeoutMs: number, repo: string): CommandResult {
  const started = Date.now();
  const result = spawnSync(command.executable, command.args, {
    cwd: command.cwd ?? worktree,
    encoding: "utf8",
    env: { ...process.env, HEPTAPOD_REPOSITORY: repo, HEPTAPOD_WORKTREE: worktree, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const output = `${result.stdout ?? ""}${result.stderr ? `${result.stdout ? "\n" : ""}${result.stderr}` : ""}`
    .replace(ANSI_ESCAPE, "");
  const timedOut = result.error && "code" in result.error && result.error.code === "ETIMEDOUT";
  return {
    status: timedOut ? "timed-out" : result.status === 0 ? "passing" : "failing",
    exitCode: result.status,
    durationMs: Date.now() - started,
    output,
    ...(result.error ? { detail: result.error.message } : {}),
  };
}

function executeTestCommand(command: TestCommand, worktree: string, timeoutMs: number, repo: string, adapter: TestRunnerAdapter, batch?: { files: string[]; format: FixtureFormat }): CommandResult {
  const result = executeCommand(command, worktree, timeoutMs, repo);
  const parsed = adapter.parseResult(result.output);
  let fixtures: CommandResult["fixtures"], batchError: string | undefined;
  if (batch) {
    try { fixtures = adapter.parseBatchResult!(result.output, command, batch.files, worktree, batch.format); }
    catch (error) { batchError = `Could not read individual batch results: ${error instanceof Error ? error.message : String(error)}`; }
  }
  const missing = batch?.files.filter(file => !fixtures?.[file]) ?? [];
  const fixtureFailures = Object.values(fixtures ?? {}).flatMap(result => result.failures);
  const fixtureFailed = Object.values(fixtures ?? {}).some(result => result.status === "failing");
  return {
    ...result,
    fixtures, batchError,
    observedFailures: [...new Set([...parsed.failures, ...fixtureFailures])],
    status: result.status === "passing" && (parsed.error || parsed.failures.length || fixtureFailed || missing.length || batchError) ? "failing" : result.status,
    detail: result.detail ?? parsed.error ?? batchError ?? (missing.length ? `No individual result was reported for: ${missing.join(", ")}.` : undefined),
    output: result.output.slice(-OUTPUT_LIMIT),
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
    observedFailures: [...new Set(results.flatMap(({ result }) => result.observedFailures ?? []))],
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
    output: run.output,
    detail,
  };
}

function targetedCommands(worktree: string, plan: TestPlan, files: string[], resultDirectory: string): TestBatchCommand[] {
  const template = plan.runnerTemplate;
  if (!template) return [];
  const present = files.filter((file) => existsSync(resolve(worktree, file)));
  if (plan.batch) return plan.adapter.batch!(worktree, template, present, plan.fixtureFormat, resultDirectory);
  return present.map((file) => {
    const target = plan.adapter.target(worktree, template, file, plan.fixtureFormat);
    return { files: [file], command: target.command, detail: target.detail };
  });
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
  const config = loadHeptapodConfig(repo);
  const worktreeDirectory = config?.test?.worktreeDirectory
    ? resolve(repo, config.test.worktreeDirectory) : tmpdir();
  mkdirSync(worktreeDirectory, { recursive: true });
  const temporaryRoot = mkdtempSync(join(worktreeDirectory, "heptapod-ingest-"));
  const worktree = join(temporaryRoot, "worktree");
  const resultDirectory = join(temporaryRoot, "results");
  mkdirSync(resultDirectory);
  let registered = false;
  const timeoutMs = configuredTimeout();
  try {
    onProgress(`Creating temporary test worktree at ${worktree}`);
    run("git", ["worktree", "add", "--detach", worktree, manifest.source.base], { cwd: repo });
    registered = true;
    const plan = detectTestPlan(worktree, config, resultDirectory);
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
      setupFailure = executeCommand(setup, worktree, timeoutMs, repo);
      dependenciesReady = setupFailure.status === "passing";
      if (!dependenciesReady) break;
    }

    const changedTestFiles = new Set<string>();
    const changesSinceBuild = new Set<string>();
    let buildReady = false;
    for (const [index, step] of manifest.steps.entries()) {
      const patch = step.diff ? readArtifact(manifestPath, step.diff) : null;
      const changedPaths = patch ? splitPatchFiles(patch.toString("utf8")).flatMap(file => {
        const rename = patchRename(file.patch);
        return rename ? [file.path, rename.from] : [file.path];
      }) : [];
      for (const path of changedPaths) changesSinceBuild.add(path);
      if (patch) {
        run("git", ["apply", "--index", "--binary", "--whitespace=nowarn", "--recount", "-"], {
          cwd: worktree,
          input: patch,
        });
      }
      for (const area of testAreasByStep.get(step.id) ?? []) {
        for (const file of area.files) {
          if (file.isFixture !== false) changedTestFiles.add(file.path);
        }
      }
      if (plan.setup.length > 0 && patch && plan.adapter.dependenciesChanged?.(changedPaths)) {
        if (plan.rebuild !== "never") buildReady = false;
        onProgress(`Refreshing dependencies after step ${index + 1}/${manifest.steps.length}`);
        for (const setup of plan.setup) {
          setupFailure = executeCommand(setup, worktree, timeoutMs, repo);
          dependenciesReady = setupFailure.status === "passing";
          if (!dependenciesReady) break;
        }
      }
      const finalStep = index === manifest.steps.length - 1;
      const files = [...changedTestFiles];
      const fixtureCommands: TestBatchCommand[] = finalStep
        ? [{ files: files.filter(file => existsSync(resolve(worktree, file))), command: plan.full }]
        : targetedCommands(worktree, plan, files, resultDirectory);
      const parseFixtures = finalStep ? Boolean(plan.adapter.parseBatchResult) : plan.batch;
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
        const buildResults: Array<{ command: TestCommand; result: CommandResult }> = [];
        const needsBuild = !buildReady || (plan.rebuild === "always" ? changesSinceBuild.size > 0
          : plan.rebuild === "auto" && plan.adapter.requiresRebuild([...changesSinceBuild]));
        if ((finalStep || fixtureCommands.some(({ command }) => command)) && needsBuild) {
          for (const command of plan.build) {
            onProgress(`Building after step ${index + 1}/${manifest.steps.length}: ${command.display}`);
            const result = executeCommand(command, worktree, timeoutMs, repo);
            buildResults.push({ command, result });
            if (result.status !== "passing") break;
          }
          buildReady = buildResults.every(({ result }) => result.status === "passing");
          if (buildReady) changesSinceBuild.clear();
        } else if (plan.build.length && (finalStep || fixtureCommands.some(({ command }) => command))) {
          onProgress(`Reusing build after step ${index + 1}/${manifest.steps.length} (${plan.rebuild} runner policy)`);
        }
        const buildFailed = buildResults.some(({ result }) => result.status !== "passing");
        if (buildFailed) {
          const result = combineCommandResults(buildResults);
          result.detail = "Build failed; tests were not run.";
          runsByStep.set(step.id, buildStepTestRun(result.command, result, step,
            finalStep ? "full-suite" : "changed-tests", files,
            files.map((file) => skippedFixtureRun(file, step, result.detail!, result.output))));
        } else {
          const fixtureRuns: TestFixtureRun[] = [];
          const executedFixtures: Array<{ command: TestCommand; result: CommandResult }> = [];
          for (const { files: batchFiles, command, detail } of fixtureCommands) {
            if (!command) {
              fixtureRuns.push(...batchFiles.map(file => skippedFixtureRun(file, step, detail ?? "The runner cannot select this fixture.")));
              continue;
            }
            onProgress(finalStep
              ? `Running the full ${plan.full.display} suite after step ${index + 1}/${manifest.steps.length}: ${step.title}`
              : `Running ${batchFiles.length > 1 ? `${batchFiles.length} test fixtures in a batch` : "test file"} after step ${index + 1}/${manifest.steps.length}: ${batchFiles.join(", ")}`);
            const result = executeTestCommand(command, worktree, timeoutMs, repo, plan.adapter,
              parseFixtures ? { files: batchFiles, format: plan.fixtureFormat } : undefined);
            executedFixtures.push({ command, result });
            for (const file of batchFiles) {
              if (!parseFixtures || result.status === "timed-out" || result.batchError) {
                fixtureRuns.push(buildFixtureRun(file, command, result, step));
                continue;
              }
              const fixture = result.fixtures?.[file];
              if (fixture?.status === "not-run") {
                fixtureRuns.push(skippedFixtureRun(file, step, fixture.detail ?? "This fixture was skipped by the test runner.", result.output));
                continue;
              }
              fixtureRuns.push(buildFixtureRun(file, command, {
                ...result, status: fixture?.status ?? "failing", durationMs: fixture?.durationMs ?? 0,
                observedFailures: fixture?.failures ?? [],
                detail: fixture ? [fixture.detail, finalStep ? "Executed in the full suite; command output and exit code are shared."
                  : batchFiles.length > 1 ? `Executed in a batch of ${batchFiles.length} fixtures; command output and exit code are shared.` : undefined].filter(Boolean).join(" ") || undefined
                  : [result.detail, "The test runner did not report a result for this fixture."].filter(Boolean).join(" "),
              }, step));
            }
          }
          if (executedFixtures.length === 0) {
            const detail = files.length ? "No runnable test fixtures were found for this step." : "No changed test files have been introduced by this step.";
            onProgress(detail);
            const run = skippedRun(step, detail, files);
            run.fixtureRuns = fixtureRuns;
            runsByStep.set(step.id, run);
          } else {
            const result = combineCommandResults([...buildResults, ...executedFixtures]);
            runsByStep.set(step.id, buildStepTestRun(result.command, result, step, finalStep ? "full-suite" : "changed-tests", files, fixtureRuns));
          }
        }
      }
      // Preserve mtimes for incremental compilers; restore only files tests/builds modified.
      const dirty = run("git", ["diff", "--name-only", "--no-renames", "-z"], { cwd: worktree }).stdout;
      if (dirty.length) {
        run("git", ["checkout-index", "-f", "-z", "--stdin"], { cwd: worktree, input: dirty });
        if (plan.rebuild !== "never") buildReady = false;
      }
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
