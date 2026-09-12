import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { getReviewDraft, saveReviewDraft, upsertReview } from "@thestraylight/heptapod/database";
import type { RenderModel, ReviewComment } from "@thestraylight/heptapod/types";
import { githubGraphql, isSameOrigin, loadDraftState, publishReviewDraft } from "../src/web/review-draft-service";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-publication-")); directories.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Example"); git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "example.test.ts"), "const value = 1;\n");
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "example.test.ts"), "const value = 2;\n");
  git("add", "."); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
  const patch = git("diff", base, head);
  vi.stubEnv("HEPTAPOD_ROOT", repo); vi.stubEnv("HEPTAPOD_DB", join(repo, "reviews.sqlite"));
  const model: RenderModel = { title: "Review example", summary: "Example", source: { base, head, diff: "source.diff", stats: { additions: 1, deletions: 1, files: 1 },
    github: { number: 42, repositoryUrl: "https://github.com/example/project", pullRequestUrl: "https://github.com/example/project/pull/42" }, files: [{ path: "example.test.ts", status: "M" }] },
    verification: { base, head, exact: true, tree: git("rev-parse", "HEAD^{tree}"), sourceBytes: patch.length, patchSteps: 1 },
    steps: [{ id: "test", number: 1, title: "Test behavior", kind: "tests", body: "Check behavior.", patch, stats: { additions: 1, deletions: 1, files: 1 }, checks: { automated: [], manual: [] },
      fileDiffs: [{ path: "example.test.ts", patch, beforeContent: "const value = 1;\n", afterContent: "const value = 2;\n" }] }],
  };
  upsertReview("42", model);
  const comments: ReviewComment[] = [
    { id: "section", body: "Overall question", target: { kind: "section", stepId: "test", anchor: "section", section: "Test behavior" } },
    { id: "file", body: "File question", target: { kind: "file", stepId: "test", anchor: "file", path: "example.test.ts" } },
    { id: "line", body: "Line question", target: { kind: "line", stepId: "test", anchor: "code", path: "example.test.ts", side: "RIGHT", startLine: 1, endLine: 1 } },
  ];
  const initial = getReviewDraft("42");
  const draft = saveReviewDraft("42", initial.version, "Final thoughts", comments);
  return { model, draft };
}

function fakeGitHub(head: string, failOnce: boolean) {
  const calls: Array<{ query: string; input: Record<string, unknown> }> = [];
  let remote: { id: string; body: string; state: string; url: string; author: { login: string } } | null = null;
  const bodies: string[] = [];
  let failed = false;
  const graphql = async <T,>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    calls.push({ query, input });
    if (query.startsWith("query($owner")) return { viewer: { login: "reviewer" }, repository: { pullRequest: { id: "PR", headRefOid: head, state: "OPEN", reviews: { nodes: remote ? [remote] : [] } } } } as T;
    if (query.includes("addPullRequestReview(input")) {
      remote = { id: "REVIEW", body: String(input.body), state: "PENDING", url: "https://github.com/example/project/pull/42#review", author: { login: "reviewer" } };
      return { addPullRequestReview: { pullRequestReview: remote } } as T;
    }
    if (query.startsWith("query($id")) return { node: { comments: { nodes: bodies.map((body) => ({ body })), pageInfo: { hasNextPage: false } } } } as T;
    if (query.includes("addPullRequestReviewThread")) {
      if (failOnce && input.subjectType === "LINE" && !failed) { failed = true; throw new Error("Network interrupted"); }
      bodies.push(String(input.body));
      return { addPullRequestReviewThread: { thread: { id: `THREAD-${bodies.length}` } } } as T;
    }
    throw new Error(`Unexpected GitHub operation: ${query}`);
  };
  return { calls, bodies, graphql: graphql satisfies typeof githubGraphql };
}

test("publishes a pending review with file and line threads and never submits it", async () => {
  const { model, draft } = fixture();
  const remote = fakeGitHub(model.source.head, false);
  const result = await publishReviewDraft("42", draft.version, remote.graphql);
  assert.ok(result.draft.publishedAt);
  assert.equal(result.draft.githubUrl, "https://github.com/example/project/pull/42/files");
  const create = remote.calls.find((call) => call.query.includes("addPullRequestReview(input"))!;
  assert.equal(create.input.commitOID, model.source.head);
  assert.equal(create.input.event, undefined);
  assert.match(String(create.input.body), /Final thoughts\n\n## Test behavior\n\nOverall question/);
  const threads = remote.calls.filter((call) => call.query.includes("addPullRequestReviewThread"));
  assert.equal(threads[0].input.subjectType, "FILE");
  assert.equal(threads[0].input.line, undefined);
  assert.equal(threads[1].input.subjectType, "LINE");
  assert.equal(threads[1].input.line, 1);
  assert.equal(threads[1].input.side, "RIGHT");
  assert.ok(remote.calls.every((call) => !call.query.includes("submitPullRequestReview")));
  const count = remote.calls.length;
  await publishReviewDraft("42", draft.version, remote.graphql);
  assert.equal(remote.calls.length, count);
});

test("retries partial publication without duplicating the pending review or completed comments", async () => {
  const { model, draft } = fixture();
  const remote = fakeGitHub(model.source.head, true);
  await assert.rejects(publishReviewDraft("42", draft.version, remote.graphql), /Network interrupted/);
  const saved = getReviewDraft("42");
  assert.equal(saved.githubReviewId, "REVIEW");
  assert.equal(saved.publishing, false);
  assert.equal(saved.publishedAt, null);
  assert.equal(saved.comments.length, 3);
  await publishReviewDraft("42", draft.version, remote.graphql);
  assert.equal(remote.calls.filter((call) => call.query.includes("addPullRequestReview(input")).length, 1);
  assert.equal(remote.bodies.length, 2);
});

test("stops publication before mutations when the PR head or local draft changes", async () => {
  const { draft } = fixture();
  const remote = fakeGitHub("c".repeat(40), false);
  await assert.rejects(publishReviewDraft("42", draft.version, remote.graphql), /new commits/);
  assert.ok(remote.calls.every((call) => call.query.startsWith("query")));
  assert.equal(getReviewDraft("42").publishing, false);
  saveReviewDraft("42", draft.version, "Edited in another tab", draft.comments);
  await assert.rejects(publishReviewDraft("42", draft.version, remote.graphql), /changed in another tab/);
  const state = await loadDraftState("42");
  assert.match(state.preview.body, /Edited in another tab/);
});


test("validates browser origins against the served host even when Next normalizes the request URL", () => {
  assert.equal(isSameOrigin(new Request("http://localhost:3107/api", { headers: { host: "127.0.0.1:3107", origin: "http://127.0.0.1:3107" } })), true);
  assert.equal(isSameOrigin(new Request("http://localhost:3107/api", { headers: { host: "127.0.0.1:3107", origin: "https://unrelated.example" } })), false);
  assert.equal(isSameOrigin(new Request("http://localhost:3107/api", { headers: { origin: "null" } })), false);
});

test("persists an edited combined summary and publishes it exactly once", async () => {
  const { model, draft } = fixture();
  const edited = "## Test behavior\n\nOverall question\n\nMy final thoughts.";
  const saved = saveReviewDraft("42", draft.version, edited, draft.comments, undefined, true);
  assert.equal(getReviewDraft("42").summaryIsCombined, true);
  assert.equal((await loadDraftState("42")).preview.body, edited);
  const remote = fakeGitHub(model.source.head, false);
  await publishReviewDraft("42", saved.version, remote.graphql);
  const create = remote.calls.find((call) => call.query.includes("addPullRequestReview(input"))!;
  assert.equal(String(create.input.body).split("<!--")[0].trim(), edited);
});
