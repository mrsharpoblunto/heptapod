import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface ConnectedRepository {
  name: string;
  githubUrl?: string;
}

export function connectedRepository(): ConnectedRepository {
  const root = process.env.HEPTAPOD_ROOT ?? process.cwd();
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const url = new URL(remote.replace(/^git@github\.com:/i, "https://github.com/"));
    const name = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "");
    if (url.hostname === "github.com" && /^[\w.-]+\/[\w.-]+$/.test(name)) {
      return { name, githubUrl: `https://github.com/${name}` };
    }
  } catch {
    // A local repository can have no GitHub remote.
  }
  return { name: basename(root) };
}
