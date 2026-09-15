import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface ConnectedRepository {
  connected: boolean;
  name: string;
  githubUrl?: string;
}

export function githubRepositoryFromRemote(remote: string): { name: string; githubUrl: string } | null {
  try {
    const url = new URL(remote.trim().replace(/^[^@\s]+@github\.com:/i, "https://github.com/"));
    const name = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "");
    return url.hostname.toLowerCase() === "github.com" && /^[\w.-]+\/[\w.-]+$/.test(name)
      ? { name, githubUrl: `https://github.com/${name}` }
      : null;
  } catch { return null; }
}

export async function connectedRepository(repository?: string): Promise<ConnectedRepository> {
  const root = repository ?? process.env.HEPTAPOD_ROOT ?? process.cwd();
  const options = { cwd: root, timeout: 5_000, encoding: "utf8" as const };
  try {
    const { stdout } = await execute("git", ["rev-parse", "--show-toplevel"], options);
    const local = { connected: true, name: basename(stdout.trim()) };
    try {
      const { stdout: remote } = await execute("git", ["remote", "get-url", "origin"], options);
      const github = githubRepositoryFromRemote(remote);
      if (github) return { connected: true, ...github };
    } catch { /* A local repository does not need an origin remote. */ }
    return local;
  } catch { return { connected: false, name: "Not connected" }; }
}
