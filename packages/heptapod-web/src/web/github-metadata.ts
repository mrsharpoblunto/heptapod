import {
  loadGitHubPullRequestMetadata as loadUncachedGitHubPullRequestMetadata,
} from "@thestraylight/heptapod-core/github-metadata";
import type { GitHubPullRequestMetadata, GitHubSource } from "@thestraylight/heptapod-core/types";

export {
  findGitHubMediaUrl,
  githubSourceFromPullRequestUrl,
  resolveGitHubMediaUrl,
} from "@thestraylight/heptapod-core/github-metadata";

const GITHUB_METADATA_CACHE_TTL_MS = 5 * 60_000;
const githubMetadataCache = new Map<string, {
  expiresAt: number;
  promise: Promise<GitHubPullRequestMetadata | null>;
}>();

export function loadGitHubPullRequestMetadata(
  source?: GitHubSource,
): Promise<GitHubPullRequestMetadata | null> {
  if (!source) return Promise.resolve(null);
  const key = source.pullRequestUrl;
  const cached = githubMetadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = loadUncachedGitHubPullRequestMetadata(source);
  githubMetadataCache.set(key, { expiresAt: Date.now() + GITHUB_METADATA_CACHE_TTL_MS, promise });
  return promise;
}

export function clearGitHubMetadataCache(source?: GitHubSource): void {
  if (source) githubMetadataCache.delete(source.pullRequestUrl);
  else githubMetadataCache.clear();
}
