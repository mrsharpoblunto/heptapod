import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { diffConfig, readConfigFile } from "./config-file.js";

const execute = promisify(execFile);
export interface DifftasticStatus { installed: boolean; version?: string }

export function difftasticEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DFT_")));
}

export function difftasticVersion(output: string): string | null {
  return /^Difftastic \d+\.\d+\.\d+/m.test(output) ? output.trim() : null;
}

/** Check the same host executable ingestion uses, without blocking other setup checks. */
export async function checkDifftastic(repo: string): Promise<DifftasticStatus> {
  try {
    const executable = diffConfig(readConfigFile(repo))?.executable ?? "difft";
    const { stdout } = await execute(executable, ["--version"], {
      cwd: repo, env: difftasticEnvironment(), timeout: 3000, killSignal: "SIGKILL", maxBuffer: 4096,
    });
    const version = difftasticVersion(stdout);
    return version ? { installed: true, version: version.split("\n")[0] } : { installed: false };
  } catch { return { installed: false }; }
}
