import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { GitHubSource } from "@thestraylight/heptapod-core/types";

const loadMetadata = vi.hoisted(() => vi.fn(async () => ({
  login: "octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/1",
  profileUrl: "https://github.com/octocat",
  state: "open" as const,
})));

vi.mock("@thestraylight/heptapod-core/github-metadata", () => ({
  findGitHubMediaUrl: vi.fn(),
  githubSourceFromPullRequestUrl: vi.fn(),
  loadGitHubPullRequestMetadata: loadMetadata,
  resolveGitHubMediaUrl: vi.fn(),
}));

import { clearGitHubMetadataCache, loadGitHubPullRequestMetadata } from "../src/web/github-metadata";

const source: GitHubSource = {
  pullRequestUrl: "https://github.com/example/project/pull/42",
  repositoryUrl: "https://github.com/example/project",
  number: 42,
};

afterEach(() => {
  clearGitHubMetadataCache();
  loadMetadata.mockClear();
  vi.useRealTimers();
});

test("reuses GitHub metadata while navigating between review pages", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
  const first = loadGitHubPullRequestMetadata(source);
  const second = loadGitHubPullRequestMetadata({ ...source });
  assert.equal(second, first);
  assert.equal(loadMetadata.mock.calls.length, 1);

  vi.advanceTimersByTime(5 * 60_000 + 1);
  assert.notEqual(loadGitHubPullRequestMetadata(source), first);
  assert.equal(loadMetadata.mock.calls.length, 2);
});

test("keeps metadata isolated by pull request", () => {
  loadGitHubPullRequestMetadata(source);
  loadGitHubPullRequestMetadata({ ...source, pullRequestUrl: "https://github.com/example/project/pull/43", number: 43 });
  assert.equal(loadMetadata.mock.calls.length, 2);
});
