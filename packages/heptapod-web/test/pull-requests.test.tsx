import assert from "node:assert/strict";
import { createElement } from "react";
import { OpenPullRequests, PreparePullRequestButton } from "../src/web/OpenPullRequests";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import type { AgentStatus } from "@thestraylight/heptapod-core/agents";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
const agent: AgentStatus = { id: "codex", name: "Codex", installed: true, authenticated: true, skillInstalled: true, loginCommand: "codex login", installUrl: "https://example.com" };
test("excludes already imported or preparing PRs and leaves the completed-PR filter off by default", async () => {
  const page = { hasNextPage: false, endCursor: null, pullRequests: [42, 43].map((number) => ({ number, title: `Review ${number}`, url: `https://github.com/example/repo/pull/${number}`, createdAt: "2026-09-12", baseRevision: "1".repeat(40), headRevision: "2".repeat(40), additions: 25, deletions: 7, metadata: { login: "example", avatarUrl: "https://example.com/avatar", profileUrl: "https://github.com/example", state: "open" as const } })) };
  const markup = renderToStaticMarkup(createElement(OpenPullRequests, { initialPage: page, importedIds: ["42"], agents: [agent] }));
  assert.doesNotMatch(markup, /Review 42/); assert.match(markup, /Review 43/);
  assert.match(markup, /1111111/); assert.match(markup, /2222222/);
  assert.match(markup, />\+25</); assert.match(markup, />−7</);
  assert.doesNotMatch(markup, /author-badge/); assert.match(markup, /title="@example"/);
  assert.ok(markup.indexOf("pr-state-open") < markup.indexOf("Review 43"));
  assert.match(markup, /Include closed and merged/); assert.doesNotMatch(markup, /checked=""/);
  const all = renderToStaticMarkup(createElement(OpenPullRequests, { initialPage: page, importedIds: ["42"], agents: [agent], includeClosed: true }));
  assert.match(all, /checked=""/);
});
test("preparation has a direct action and only adds a dropdown for multiple installed, authenticated agents", () => {
  const props = { number: 43, starting: false, onPrepare: () => {} };
  const unavailable: AgentStatus = { ...agent, id: "claude", name: "Claude Code", authenticated: false };
  const single = renderToStaticMarkup(createElement(PreparePullRequestButton, { ...props, agents: [agent, unavailable] }));
  assert.match(single, /Import PR #43 with Codex/); assert.doesNotMatch(single, /<details/);
  const combo = renderToStaticMarkup(createElement(PreparePullRequestButton, { ...props, agents: [agent, { ...unavailable, authenticated: true }] }));
  assert.match(combo, /Choose agent for PR #43/); assert.match(combo, /role="menuitem"/); assert.match(combo, /Claude Code/);
  const none = renderToStaticMarkup(createElement(PreparePullRequestButton, { ...props, agents: [unavailable] }));
  assert.match(none, /disabled=""/); assert.doesNotMatch(none, /<details/);
});
