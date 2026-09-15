import { checkDifftastic } from "@thestraylight/heptapod-core/difftastic";
import { detectAgents } from "@thestraylight/heptapod-core/agents";
import { connectedRepository } from "./connected-repository";
import { checkGitHub, checkSkills } from "./setup";
import type { SetupPromises } from "./SetupContext";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SETUP_CACHE_TTL_MS = 5 * 60_000;
const setupCache = new Map<string, { expiresAt: number; promises: SetupPromises }>();

async function checkClient(root: string): Promise<{ installed: boolean; version?: string }> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "node_modules/@thestraylight/heptapod/package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? { installed: true, version: manifest.version } : { installed: true };
  } catch { return { installed: false }; }
}

export function startSetupChecks(root = process.env.HEPTAPOD_ROOT ?? process.cwd()): SetupPromises {
  const key = resolve(root);
  const cached = setupCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promises;
  const promises = {
    client: checkClient(key),
    repository: connectedRepository(key),
    github: checkGitHub(),
    skills: checkSkills(key),
    difftastic: checkDifftastic(key),
    agents: detectAgents(key).then((agents) => ({ agents }), (error: unknown) => ({
      agents: [], error: error instanceof Error ? error.message : "Check the agent settings in .heptapod.json.",
    })),
  };
  setupCache.set(key, { expiresAt: Date.now() + SETUP_CACHE_TTL_MS, promises });
  return promises;
}

export function clearSetupCheckCache(root?: string): void {
  if (root) setupCache.delete(resolve(root));
  else setupCache.clear();
}
