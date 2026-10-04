import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  source: { id: "1", base: "a".repeat(40), head: "b".repeat(40), githubPrUrl: "https://github.com/example/repo/pull/1", title: "Change" },
  spawn: vi.fn(), getReview: vi.fn(), update: vi.fn(), fail: vi.fn(), capture: vi.fn(), load: vi.fn(), verify: vi.fn(), evidence: vi.fn(), directory: "",
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/tool/cache.js", () => ({ resolveReviewRunDirectory: () => mocks.directory }));
vi.mock("../src/tool/url.js", () => ({ buildReviewUrl: () => "http://localhost/reviews/1" }));
vi.mock("../src/tool/capture.js", () => ({ captureNarrative: mocks.capture }));
vi.mock("../src/tool/database.js", () => ({ getReview: mocks.getReview, beginReviewPreparation: mocks.update, failReviewIngestion: mocks.fail }));
vi.mock("../src/tool/manifest.js", () => ({ loadManifest: mocks.load }));
vi.mock("../src/tool/verify.js", () => ({ verifyNarrative: mocks.verify }));
vi.mock("../src/tool/test-analysis.js", () => ({ analyzeNarrative: () => ({ testFixturesByStep: new Map() }) }));
vi.mock("../src/tool/test-evidence.js", () => ({ loadTestEvidence: mocks.evidence }));
vi.mock("../src/tool/review-source.js", () => ({ parsePullRequestNumber: Number, resolvePullRequest: () => mocks.source }));
vi.mock("../src/tool/connected-repository.js", () => ({ connectedRepository: async () => ({ githubUrl: "https://github.com/example/repo" }) }));
vi.mock("../src/tool/setup.js", () => ({ checkGitHub: async () => ({ authenticated: true }) }));
vi.mock("../src/tool/agents.js", () => ({
  detectAgents: async () => [{ id: "codex", name: "Codex", installed: true, skillInstalled: true }],
  supportedAgents: [{ id: "codex", skillPath: ".agents/skills/heptapod/SKILL.md" }],
  agentArguments: (_id: string, prompt: string) => [prompt],
}));
import { prepareReview } from "../src/tool/prepare.js";
const directories: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(ingested: boolean) {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-prepare-")); directories.push(repo);
  mocks.directory = join(repo, "artifacts"); mkdirSync(mocks.directory);
  const narrative = join(mocks.directory, "narrative.json"); writeFileSync(narrative, "{}");
  const manifest = { source: { base: mocks.source.base, head: mocks.source.head, github: { pullRequestUrl: mocks.source.githubPrUrl } } };
  const review = { id: "1", status: "ready", baseRevision: mocks.source.base, headRevision: mocks.source.head, sourceUrl: mocks.source.githubPrUrl, metadataDirectory: mocks.directory, payload: manifest };
  mocks.getReview.mockReturnValueOnce(review).mockReturnValue(ingested ? review : { ...review, status: "pending" });
  mocks.load.mockReturnValue({ manifest, manifestPath: narrative });
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  return { repo };
}

test("unchanged comparisons launch the skill again and return the agent-ingested review", async () => {
  const { repo } = fixture(true);
  const result = await prepareReview(repo, "1", "codex", undefined, true, { quiet: true, onProgress: () => {} });
  assert.equal(result.status, "ready"); assert.equal(mocks.capture.mock.calls.length, 0);
  assert.equal(mocks.spawn.mock.calls.length, 1);
  const prompt = mocks.spawn.mock.calls[0][1][0];
  assert.match(prompt, /rerun the tests yourself/);
  assert.match(prompt, /ingest --pr 1 --publish false/);
  assert.equal(mocks.verify.mock.calls.length, 1); assert.equal(mocks.evidence.mock.calls.length, 1);
});

test("successful agent exit without ingestion cannot reuse the old ready payload", async () => {
  const { repo } = fixture(false);
  await assert.rejects(prepareReview(repo, "1", "codex", undefined, true, { quiet: true, onProgress: () => {} }), /did not complete local ingestion/);
  assert.equal(mocks.update.mock.calls.length, 1); assert.equal(mocks.fail.mock.calls.length, 1);
});
