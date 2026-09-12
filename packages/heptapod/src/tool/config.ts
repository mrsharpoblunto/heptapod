import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HeptapodCommandConfig {
  command: string[];
}

export interface HeptapodConfig {
  test?: {
    prerequisites?: HeptapodCommandConfig[];
    runner?: HeptapodCommandConfig;
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
  const path = join(repo, ".heptapod.json");
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object") throw new Error("Invalid .heptapod.json: root must be an object.");
  const config = value as HeptapodConfig;
  if (config.test !== undefined) {
    if (!config.test || typeof config.test !== "object") throw new Error("Invalid .heptapod.json: test must be an object.");
    if (config.test.prerequisites !== undefined) {
      if (!Array.isArray(config.test.prerequisites)) throw new Error("Invalid .heptapod.json: test.prerequisites must be an array.");
      config.test.prerequisites.forEach((command, index) => assertCommand(command, `test.prerequisites[${index}]`));
    }
    if (config.test.runner !== undefined) assertCommand(config.test.runner, "test.runner");
  }
  return config;
}
