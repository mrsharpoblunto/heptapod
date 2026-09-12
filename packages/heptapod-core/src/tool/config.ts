import type { AgentId } from "./agents.js";
import { agentPreferences, readConfigFile } from "./config-file.js";
import { fixtureAdapters, type FixtureFormat } from "./test-fixtures/index.js";
import { runnerAdapters, type RunnerFormat } from "./test-runners/index.js";

export interface HeptapodCommandConfig {
  command: string[];
}

export interface HeptapodTestRunnerConfig extends HeptapodCommandConfig {
  format?: RunnerFormat;
}

export interface HeptapodConfig {
  agents?: { preferenceOrder?: AgentId[] };
  test?: {
    prerequisites?: HeptapodCommandConfig[];
    build?: HeptapodCommandConfig[];
    runner?: HeptapodTestRunnerConfig;
    fixtures?: { format: FixtureFormat };
    worktreeDirectory?: string;
  };
}

function assertCommand(value: unknown, label: string): asserts value is HeptapodCommandConfig {
  if (!value || typeof value !== "object" || !("command" in value)) {
    throw new Error(`Invalid .heptapod.json: ${label} must contain a command array.`);
  }
  const command = (value as { command?: unknown }).command;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error(`Invalid .heptapod.json: ${label}.command must be a non-empty array of strings.`);
  }
}

export function loadHeptapodConfig(repo: string): HeptapodConfig | null {
  const value = readConfigFile(repo);
  if (!value) return null;
  agentPreferences(value);
  const config = value as HeptapodConfig;
  if (config.test !== undefined) {
    if (!config.test || typeof config.test !== "object" || Array.isArray(config.test)) throw new Error("Invalid .heptapod.json: test must be an object.");
    for (const field of ["prerequisites", "build"] as const) {
      if (config.test[field] === undefined) continue;
      if (!Array.isArray(config.test[field])) throw new Error(`Invalid .heptapod.json: test.${field} must be an array.`);
      config.test[field].forEach((command, index) => assertCommand(command, `test.${field}[${index}]`));
    }
    if (config.test.runner !== undefined) {
      assertCommand(config.test.runner, "test.runner");
      const format = config.test.runner.format;
      if (format !== undefined && (typeof format !== "string" || !Object.hasOwn(runnerAdapters, format))) {
        throw new Error(`Invalid .heptapod.json: test.runner.format must be ${Object.keys(runnerAdapters).join(" or ")}.`);
      }
      try {
        runnerAdapters[format ?? "command"].validateCommand?.(config.test.runner.command);
      } catch (error) {
        throw new Error(`Invalid .heptapod.json: test.runner.command: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (config.test.fixtures !== undefined) {
      const format = config.test.fixtures?.format;
      if (typeof format !== "string" || (format !== "auto" && !Object.hasOwn(fixtureAdapters, format))) {
        throw new Error(`Invalid .heptapod.json: test.fixtures.format must be auto, ${Object.keys(fixtureAdapters).join(" or ")}.`);
      }
    }
    if (config.test.worktreeDirectory !== undefined && (typeof config.test.worktreeDirectory !== "string" || !config.test.worktreeDirectory.trim())) {
      throw new Error("Invalid .heptapod.json: test.worktreeDirectory must be a non-empty path.");
    }
  }
  return config;
}
