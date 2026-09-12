import { resolveCommit } from "./git.js";
import { run } from "./process.js";

export interface ReviewSourceSelection {
  id: string;
  base: string;
  head: string;
  githubPrUrl?: string;
  title?: string;
}

interface GitHubPullRequest {
  baseRefOid?: unknown;
  headRefOid?: unknown;
  url?: unknown;
  title?: unknown;
}

export function parsePullRequestNumber(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error("--pr must be a positive GitHub pull-request number");
  }
  return Number(value);
}

export function parseRevisionRange(value: string): { baseRef: string; headRef: string } {
  const parts = value.split("...");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("--rev must use the form <base>...<target>");
  }
  return { baseRef: parts[0], headRef: parts[1] };
}

function ensureCommit(repo: string, revision: string, fallbackRef?: string): string {
  const available = run("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: repo,
    allowFailure: true,
  });
  if (available.status !== 0) {
    const ref = fallbackRef ?? revision;
    const fetched = run("git", ["fetch", "--no-tags", "origin", ref], { cwd: repo, allowFailure: true });
    if (fetched.status !== 0) {
      const detail = fetched.stderr.toString("utf8").trim();
      throw new Error(`Could not fetch revision ${revision}${detail ? `: ${detail}` : "."}`);
    }
  }
  return resolveCommit(repo, revision);
}

export function resolvePullRequest(repo: string, value: string): ReviewSourceSelection {
  const number = parsePullRequestNumber(value);
  const result = run("gh", ["api", `repos/{owner}/{repo}/pulls/${number}`, "--jq", "{baseRefOid: .base.sha, headRefOid: .head.sha, url: .html_url, title: .title}"], {
    cwd: repo,
    allowFailure: true,
  });
  if (result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(`Could not load GitHub PR #${number}${detail ? `: ${detail}` : "."}`);
  }
  const pullRequest = JSON.parse(result.stdout.toString("utf8")) as GitHubPullRequest;
  if (
    typeof pullRequest.baseRefOid !== "string"
    || typeof pullRequest.headRefOid !== "string"
    || typeof pullRequest.url !== "string"
  ) {
    throw new Error(`GitHub returned incomplete revision metadata for PR #${number}.`);
  }
  const base = ensureCommit(repo, pullRequest.baseRefOid);
  const head = ensureCommit(repo, pullRequest.headRefOid, `pull/${number}/head`);
  return { id: String(number), base, head, githubPrUrl: pullRequest.url, title: typeof pullRequest.title === "string" ? pullRequest.title : undefined };
}

export function resolveRevisionRange(repo: string, value: string): ReviewSourceSelection {
  const { baseRef, headRef } = parseRevisionRange(value);
  const base = resolveCommit(repo, baseRef);
  const head = resolveCommit(repo, headRef);
  return { id: `${base}/${head}`, base, head };
}
