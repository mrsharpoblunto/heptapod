import { execFile } from "node:child_process";
import {
  claimReviewDraftPublication, finishReviewDraftPublication, getReview, getReviewDraft, recordGitHubDraft,
} from "./database.js";
import { buildReviewDraftPreview } from "./review-draft.js";
import type { ReviewDraft, ReviewDraftPreview } from "./types.js";
import { githubSourceFromPullRequestUrl } from "./github-metadata.js";

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host); }
  catch { return false; }
}

function execute(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || `${command} failed. Check that GitHub CLI is installed and signed in.`));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

export async function githubGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = JSON.parse(await execute("gh", ["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }))) as { data?: T; errors?: Array<{ message: string }> };
  if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).join("\n"));
  if (!response.data) throw new Error("GitHub returned an empty response.");
  return response.data;
}

export interface ReviewStorage {
  root?: string;
  databasePath?: string;
  loadPatch?: (root: string, base: string, head: string) => Promise<string>;
}

export async function loadDraftState(reviewId: string, storage: ReviewStorage = {}): Promise<{ draft: ReviewDraft; preview: ReviewDraftPreview }> {
  const review = getReview(reviewId, storage.databasePath);
  if (!review?.payload?.source.github) throw new Error("Review drafts are only available for GitHub pull requests.");
  const draft = getReviewDraft(reviewId, storage.databasePath);
  const { base, head } = review.payload.source;
  if (!/^[a-f\d]{40}$/i.test(base) || !/^[a-f\d]{40}$/i.test(head)) throw new Error("The review has invalid Git revisions.");
  const root = storage.root ?? process.env.HEPTAPOD_ROOT ?? process.cwd();
  const patch = storage.loadPatch
    ? await storage.loadPatch(root, base, head)
    : await execute("git", ["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames=50%", base, head, "--"]);
  return { draft, preview: buildReviewDraftPreview(review.payload, draft, patch) };
}

interface GitHubReview { id: string; body: string; state: string; url: string; author: { login: string } }
interface GitHubReviewComment { body: string }

// Keep the transport injectable so publication can be verified without posting a review.
export async function publishReviewDraft(reviewId: string, version: number, graphql: typeof githubGraphql = githubGraphql, storage: ReviewStorage = {}): Promise<{ draft: ReviewDraft; preview: ReviewDraftPreview }> {
  const state = await loadDraftState(reviewId, storage);
  if (state.draft.publishedAt) return state;
  if (state.draft.version !== version) throw new Error("This draft changed in another tab. Reload before publishing.");
  if (state.preview.errors.length) throw new Error(state.preview.errors.join("\n"));
  if (!state.preview.body.trim() && !state.preview.threads.length) throw new Error("Add a comment or summary before publishing.");
  const review = getReview(reviewId, storage.databasePath)!;
  const source = githubSourceFromPullRequestUrl(review.payload?.source.github?.pullRequestUrl);
  if (!source) throw new Error("This review does not have a valid GitHub pull request.");
  const [owner, name] = new URL(source.repositoryUrl).pathname.slice(1).split("/");
  const claimed = claimReviewDraftPublication(reviewId, version, storage.databasePath);
  if (claimed.publishedAt) return { ...state, draft: claimed };
  try {
    const remote = await graphql<{ viewer: { login: string }; repository: { pullRequest: { id: string; headRefOid: string; state: string; reviews: { nodes: GitHubReview[] } } } }>(
      "query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid state reviews(first:100,states:PENDING){nodes{id body state url author{login}}}}}}",
      { owner, name, number: source.number },
    );
    const pr = remote.repository?.pullRequest;
    if (!pr) throw new Error("The GitHub pull request was not found.");
    if (pr.headRefOid !== claimed.head) throw new Error("The GitHub PR has new commits. Capture the updated PR before publishing comments.");
    if (pr.state !== "OPEN") throw new Error("This GitHub PR is closed. Draft comments can only be published to an open PR.");
    const marker = `<!-- heptapod-review:${claimed.id} -->`;
    const owned = pr.reviews.nodes.filter((review) => review.author.login === remote.viewer.login);
    let pending = owned.find((review) => review.id === claimed.githubReviewId || review.body.includes(marker));
    if (!pending && claimed.githubReviewId) throw new Error("The GitHub draft was submitted or removed. Open the review on GitHub.");
    if (!pending && owned.length) throw new Error("You already have a pending review on this PR. Submit or discard it on GitHub before publishing this draft.");
    if (!pending) {
      const created = await graphql<{ addPullRequestReview: { pullRequestReview: GitHubReview } }>(
        "mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id body state url author{login}}}}",
        { input: { pullRequestId: pr.id, commitOID: claimed.head, body: `${state.preview.body}\n\n${marker}` } },
      );
      pending = created.addPullRequestReview.pullRequestReview;
    }
    if (!pending || pending.state !== "PENDING") throw new Error("GitHub did not create a pending review.");
    const githubUrl = `${source.pullRequestUrl}/files`;
    recordGitHubDraft(reviewId, pending.id, githubUrl, storage.databasePath);
    const reviewBody = `${state.preview.body}\n\n${marker}`;
    if (pending.body !== reviewBody) {
      await graphql("mutation($input:UpdatePullRequestReviewInput!){updatePullRequestReview(input:$input){pullRequestReview{id}}}",
        { input: { pullRequestReviewId: pending.id, body: reviewBody } });
    }
    const existing: GitHubReviewComment[] = [];
    let after: string | null = null;
    do {
      const result: { node: { comments: { nodes: GitHubReviewComment[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } } = await graphql(
        "query($id:ID!,$after:String){node(id:$id){... on PullRequestReview{comments(first:100,after:$after){nodes{body} pageInfo{hasNextPage endCursor}}}}}",
        { id: pending.id, after },
      );
      existing.push(...result.node.comments.nodes);
      after = result.node.comments.pageInfo.hasNextPage ? result.node.comments.pageInfo.endCursor : null;
    } while (after);
    for (const thread of state.preview.threads) {
      const commentMarker = `<!-- heptapod-comment:${thread.commentId} -->`;
      if (existing.some((comment) => comment.body.includes(commentMarker))) continue;
      // Renew the lease during long reviews so another request cannot publish the same threads.
      recordGitHubDraft(reviewId, pending.id, githubUrl, storage.databasePath);
      await graphql(
        "mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}",
        { input: { pullRequestReviewId: pending.id, path: thread.path, subjectType: thread.subjectType,
          body: `${thread.body}\n\n${commentMarker}`,
          ...(thread.subjectType === "LINE" ? { line: thread.line, side: thread.side,
            ...(thread.startLine ? { startLine: thread.startLine, startSide: thread.side } : {}) } : {}),
        } },
      );
    }
    return { ...state, draft: finishReviewDraftPublication(reviewId, true, storage.databasePath) };
  } catch (error) {
    finishReviewDraftPublication(reviewId, false, storage.databasePath);
    throw error;
  }
}
