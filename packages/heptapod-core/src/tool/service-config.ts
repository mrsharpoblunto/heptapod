import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHeptapodStateDirectory } from "./repositories.js";

export const DEFAULT_SERVICE_PORT = 49_731;

export interface HeptapodServiceConfig { port: number }

export function resolveServiceConfigPath(): string {
  return join(resolveHeptapodStateDirectory(), "config.json");
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1_024 && value <= 65_535;
}

export function readServiceConfig(): HeptapodServiceConfig {
  try {
    const parsed = JSON.parse(readFileSync(resolveServiceConfigPath(), "utf8")) as { port?: unknown };
    if (!validPort(parsed.port)) throw new Error("port must be an integer from 1024 through 65535");
    return { port: parsed.port };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { port: DEFAULT_SERVICE_PORT };
    throw new Error(`Invalid Heptapod service config at ${resolveServiceConfigPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeServiceConfig(port: number): HeptapodServiceConfig {
  if (!validPort(port)) throw new Error("Service port must be an integer from 1024 through 65535.");
  const config = { port };
  mkdirSync(resolveHeptapodStateDirectory(), { recursive: true });
  writeFileSync(resolveServiceConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

export function serviceWebUrl(config = readServiceConfig()): string {
  return `http://localhost:${config.port}`;
}

export function serviceApiUrl(config = readServiceConfig()): string {
  return `http://localhost:${config.port}/api/service`;
}
