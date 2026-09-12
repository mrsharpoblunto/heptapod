import { execFile } from "node:child_process";
import type { GitHubPullRequestMetadata, GitHubSource } from "./types.js";

interface GitHubApiPullRequest {
  state?: unknown;
  draft?: unknown;
  merged_at?: unknown;
  user?: {
    login?: unknown;
    avatar_url?: unknown;
    html_url?: unknown;
  };
}

export function githubSourceFromPullRequestUrl(value: string | null | undefined): GitHubSource | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (url.origin !== "https://github.com" || !match) return undefined;
    const [, owner, repository, number] = match;
    if (!owner || !repository || !number) return undefined;
    return {
      pullRequestUrl: `https://github.com/${owner}/${repository}/pull/${number}`,
      repositoryUrl: `https://github.com/${owner}/${repository}`,
      number: Number(number),
    };
  } catch {
    return undefined;
  }
}

function executeGitHub(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5_000,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function loadGitHubPullRequestMetadata(
  source?: GitHubSource,
): Promise<GitHubPullRequestMetadata | null> {
  if (!source) return null;
  try {
    const repositoryUrl = new URL(source.repositoryUrl);
    const repository = repositoryUrl.pathname.replace(/^\//, "").replace(/\/$/, "");
    if (!repository || repositoryUrl.origin.toLowerCase() !== "https://github.com") return null;
    const pullRequest = JSON.parse(
      await executeGitHub(["api", `repos/${repository}/pulls/${source.number}`]),
    ) as GitHubApiPullRequest;
    const login = pullRequest.user?.login;
    const avatarUrl = pullRequest.user?.avatar_url;
    const profileUrl = pullRequest.user?.html_url;
    if (typeof login !== "string" || typeof avatarUrl !== "string" || typeof profileUrl !== "string") return null;
    const state = pullRequest.merged_at
      ? "merged"
      : pullRequest.draft
        ? "draft"
        : pullRequest.state === "closed"
          ? "closed"
          : "open";
    return { login, avatarUrl, profileUrl, state };
  } catch {
    return null;
  }
}

export function findGitHubMediaUrl(html: string, assetId: string, kind: "image" | "video"): string | null {
  const pattern = kind === "image" ? /<img\b[^>]+\bsrc="([^"]+)"/gi : /<video\b[^>]+\bsrc="([^"]+)"/gi;
  for (const match of html.matchAll(pattern)) {
    const value = match[1].replaceAll("&amp;", "&");
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && ["github.com", "private-user-images.githubusercontent.com", "user-images.githubusercontent.com"].includes(url.hostname)
        && url.pathname.includes(assetId)) return value;
    } catch { /* Ignore malformed attachment sources. */ }
  }
  return null;
}

export async function resolveGitHubMediaUrl(source: GitHubSource, assetId: string, kind: "image" | "video"): Promise<string | null> {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(assetId)) return null;
  try {
    const repositoryUrl = new URL(source.repositoryUrl);
    const [owner, name, ...rest] = repositoryUrl.pathname.split("/").filter(Boolean);
    if (!owner || !name || rest.length > 0 || repositoryUrl.origin.toLowerCase() !== "https://github.com") return null;
    const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){bodyHTML comments(first:100){nodes{bodyHTML}}}}}";
    const response = JSON.parse(await executeGitHub([
      "api", "graphql",
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
      "-F", `number=${source.number}`,
      "-f", `query=${query}`,
    ])) as {
      data?: { repository?: { pullRequest?: { bodyHTML?: string; comments?: { nodes?: Array<{ bodyHTML?: string }> } } } };
    };
    const pullRequest = response.data?.repository?.pullRequest;
    const html = [pullRequest?.bodyHTML ?? "", ...(pullRequest?.comments?.nodes ?? []).map((comment) => comment.bodyHTML ?? "")].join("\n");
    return findGitHubMediaUrl(html, assetId, kind);
  } catch {
    return null;
  }
}
