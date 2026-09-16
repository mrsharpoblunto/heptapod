import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "./agents.js";

export interface HeptapodDiffConfig {
  engine?: "difftastic" | "standard";
  executable?: string;
  timeoutMs?: number;
}

export function readConfigFile(repo: string): Record<string, unknown> | null {
  const path = join(repo, ".heptapod.json");
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid .heptapod.json: root must be an object.");
  return value as Record<string, unknown>;
}

export function agentPreferences(value: Record<string, unknown> | null): AgentId[] {
  const config = value as { agents?: { preferenceOrder?: AgentId[] } } | null;
  if (!config) return [];
  if (config.agents !== undefined) {
    if (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)) throw new Error("Invalid .heptapod.json: agents must be an object.");
    const order = config.agents.preferenceOrder;
    if (order !== undefined && (!Array.isArray(order) || order.some((id) => id !== "codex" && id !== "claude") || new Set(order).size !== order.length)) {
      throw new Error("Invalid .heptapod.json: agents.preferenceOrder must be an array of unique supported agent IDs (codex, claude).");
    }
  }
  return config.agents?.preferenceOrder ?? [];
}

export function diffConfig(value: Record<string, unknown> | null): HeptapodDiffConfig | undefined {
  const diff = value?.diff;
  if (diff === undefined) return undefined;
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
    throw new Error("Invalid .heptapod.json: diff must be an object.");
  }
  const config = diff as HeptapodDiffConfig;
  if (config.engine !== undefined && config.engine !== "difftastic" && config.engine !== "standard") {
    throw new Error("Invalid .heptapod.json: diff.engine must be difftastic or standard.");
  }
  if (config.executable !== undefined && (typeof config.executable !== "string" || !config.executable.trim())) {
    throw new Error("Invalid .heptapod.json: diff.executable must be a non-empty executable path.");
  }
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new Error("Invalid .heptapod.json: diff.timeoutMs must be a positive integer.");
  }
  return config;
}
