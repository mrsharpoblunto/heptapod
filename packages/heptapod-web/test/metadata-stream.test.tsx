import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { test } from "vitest";
import { GitHubMetadataProvider, metadataCacheReducer } from "../src/web/GitHubIdentity";
import { ReviewHeader } from "../src/web/ReviewHeader";
import type { GitHubPullRequestMetadata } from "@thestraylight/heptapod-core/types";

test("streams the review header before its server-started GitHub metadata resolves", async () => {
  let resolveMetadata!: (metadata: GitHubPullRequestMetadata) => void;
  const metadata = new Promise<GitHubPullRequestMetadata>((resolve) => { resolveMetadata = resolve; });
  const output = new PassThrough(); let html = ""; output.on("data", (chunk) => { html += chunk.toString(); });
  const ended = new Promise<void>((resolve, reject) => { output.on("end", resolve); output.on("error", reject); });
  let shell!: () => void; const ready = new Promise<void>((resolve) => { shell = resolve; });
  const stream = renderToPipeableStream(createElement(GitHubMetadataProvider, { promises: { "42": metadata }, children:
    createElement(ReviewHeader, { compact: true, review: { id: "42", title: "Streamed title", summary: "", sourceUrl: "https://github.com/example/repo/pull/42", baseRevision: "", headRevision: "", updatedAt: "2026-09-12", additions: null, deletions: null } }),
  }), { onShellReady: () => { stream.pipe(output); shell(); }, onError: (error) => { output.destroy(error as Error); } });
  await ready;
  assert.match(html, /Streamed title/); assert.match(html, /avatar-shimmer/); assert.doesNotMatch(html, /https:\/\/example.com\/avatar/);
  resolveMetadata({ login: "reviewer", avatarUrl: "https://example.com/avatar", profileUrl: "https://github.com/reviewer", state: "open" });
  await ended; assert.match(html, /https:\/\/example.com\/avatar/); assert.match(html, /@reviewer/);
});


test("metadata store retains cached identity during refresh and ignores superseded promises", () => {
  const original = Promise.resolve(null);
  const refresh = Promise.resolve(null);
  const latest = Promise.resolve(null);
  const metadata: GitHubPullRequestMetadata = { login: "reviewer", avatarUrl: "https://example.com/avatar", profileUrl: "https://github.com/reviewer", state: "open" };
  let cache = metadataCacheReducer({}, { type: "request", reviewId: "42", promise: original });
  cache = metadataCacheReducer(cache, { type: "resolve", reviewId: "42", promise: original, metadata });
  cache = metadataCacheReducer(cache, { type: "request", reviewId: "42", promise: refresh });
  assert.equal(cache["42"].metadata, metadata);
  cache = metadataCacheReducer(cache, { type: "request", reviewId: "42", promise: latest });
  assert.equal(metadataCacheReducer(cache, { type: "resolve", reviewId: "42", promise: refresh, metadata: null }), cache);
  cache = metadataCacheReducer(cache, { type: "resolve", reviewId: "42", promise: latest, metadata: { ...metadata, state: "merged" } });
  assert.equal(cache["42"].metadata?.state, "merged");
});
