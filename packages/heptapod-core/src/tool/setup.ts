import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentSkillInstalled, supportedAgents } from "./agents.js";
import type { GitHubPullRequestMetadata } from "./types.js";

const execute = promisify(execFile);
export interface GitHubStatus { installed: boolean; authenticated: boolean }
export async function checkGitHub(): Promise<GitHubStatus> {
  const options = { timeout: 5_000, maxBuffer: 64 * 1024 };
  try { await execute("gh", ["--version"], options); } catch { return { installed: false, authenticated: false }; }
  try { await execute("gh", ["auth", "status", "--hostname", "github.com"], options); return { installed: true, authenticated: true }; }
  catch { return { installed: true, authenticated: false }; }
}
export async function checkSkills(root: string): Promise<boolean> {
  return (await Promise.all(supportedAgents.map((agent) => agentSkillInstalled(root, agent.skillPath)))).every(Boolean);
}
export interface OpenPullRequest {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  metadata: GitHubPullRequestMetadata;
  baseRevision: string;
  headRevision: string;
  additions: number;
  deletions: number;
}
interface ApiPullRequest {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefOid: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  author: { login: string; avatarUrl: string; url: string } | null;
}

export interface PullRequestPage {
  pullRequests: OpenPullRequest[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export async function loadPullRequestPage(repository: string, includeClosed = false, after?: string): Promise<PullRequestPage> {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length) throw new Error("Expected an owner/repository name.");
  // Fetch one bounded page, including diff totals without a request per PR.
  const query = `query($owner:String!,$name:String!,$endCursor:String) {
    repository(owner:$owner,name:$name) {
      pullRequests(first:25,after:$endCursor,states:[${includeClosed ? "OPEN,CLOSED,MERGED" : "OPEN"}],orderBy:{field:CREATED_AT,direction:DESC}) {
        nodes { number title url createdAt isDraft state baseRefOid headRefOid additions deletions author { login avatarUrl url } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
  const { stdout } = await execute("gh", ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${query}`, ...(after ? ["-f", `endCursor=${after}`] : [])], {
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  const page = JSON.parse(stdout) as { data?: { repository?: { pullRequests: { nodes: ApiPullRequest[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } }; errors?: Array<{ message: string }> };
  if (page.errors?.length || !page.data?.repository) throw new Error(page.errors?.[0]?.message ?? "Could not load repository pull requests.");
  const { nodes, pageInfo } = page.data.repository.pullRequests;
  if (pageInfo.hasNextPage && (!pageInfo.endCursor || pageInfo.endCursor === after)) throw new Error("GitHub returned an invalid pagination cursor.");
  const pullRequests = nodes.map((pr) => ({
    number: pr.number, title: pr.title, url: pr.url, createdAt: pr.createdAt,
    baseRevision: pr.baseRefOid, headRevision: pr.headRefOid, additions: pr.additions, deletions: pr.deletions,
    metadata: {
      login: pr.author?.login ?? "ghost", avatarUrl: pr.author?.avatarUrl ?? "https://github.com/ghost.png", profileUrl: pr.author?.url ?? "https://github.com/ghost",
      state: pr.state === "MERGED" ? "merged" as const : pr.state === "CLOSED" ? "closed" as const : pr.isDraft ? "draft" as const : "open" as const,
    },
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { pullRequests, ...pageInfo };
}
