import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "@thestraylight/heptapod-core/git";
import { checkService, listRemoteRepositories } from "./client.js";

export async function viewUrl(base: string, repo?: string, pr?: string): Promise<string> {
  if (pr !== undefined && (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr)))) {
    throw new Error("--pr must be a positive pull request number.");
  }
  const url = new URL("/", base);
  if (repo === undefined && pr === undefined) {
    await checkService(base);
    return url.toString();
  }

  const selected = repo ?? ".";
  const expanded = selected === "~" ? homedir() : selected.startsWith("~/") ? join(homedir(), selected.slice(2)) : selected;
  const root = existsSync(expanded) ? realpathSync(repositoryRoot(expanded)) : undefined;
  const repositories = await listRemoteRepositories(base);
  const matches = root
    ? repositories.filter((repository) => repository.root === root)
    : repositories.filter((repository) => repository.id === selected || repository.name === selected);
  if (matches.length === 0) {
    throw new Error(`Repository ${selected} is not registered with this service. Run \`heptapod repo add\` from the repository, or use a name or ID from \`heptapod repo list\`.`);
  }
  if (matches.length > 1) throw new Error(`Repository ${selected} is ambiguous. Use its path or ID from \`heptapod repo list\`.`);
  url.pathname = `/repositories/${encodeURIComponent(matches[0].id)}${pr ? `/reviews/${pr}` : ""}`;
  return url.toString();
}

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || "Browser launcher failed.";
    throw new Error(`Could not open the browser (${detail}). Open ${url} manually.`);
  }
}
