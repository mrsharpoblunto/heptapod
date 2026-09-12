import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  maxBuffer?: number;
  allowFailure?: boolean;
}

export class CommandError extends Error {
  exitCode: number;

  constructor(command: string[], result: SpawnSyncReturns<Buffer>) {
    const stderr = result.stderr?.toString("utf8").trim();
    const stdout = result.stdout?.toString("utf8").trim();
    super(`${command.join(" ")} failed${stderr || stdout ? `: ${stderr || stdout}` : ""}`);
    this.name = "CommandError";
    this.exitCode = result.status ?? 1;
  }
}

export function run(command: string, args: string[], options: RunOptions = {}): SpawnSyncReturns<Buffer> {
  const printable = [command, ...args];
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new CommandError(printable, result);
  }
  return result;
}
