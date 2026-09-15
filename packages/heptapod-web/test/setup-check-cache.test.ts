import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const checks = vi.hoisted(() => ({
  agents: vi.fn(async () => []),
  difftastic: vi.fn(async () => ({ installed: true })),
  github: vi.fn(async () => ({ installed: true, authenticated: true })),
  repository: vi.fn(async (root: string) => ({ connected: true, name: root })),
  skills: vi.fn(async () => true),
}));

vi.mock("@thestraylight/heptapod-core/agents", () => ({ detectAgents: checks.agents }));
vi.mock("@thestraylight/heptapod-core/difftastic", () => ({ checkDifftastic: checks.difftastic }));
vi.mock("../src/web/connected-repository", () => ({ connectedRepository: checks.repository }));
vi.mock("../src/web/setup", () => ({ checkGitHub: checks.github, checkSkills: checks.skills }));

import { clearSetupCheckCache, startSetupChecks } from "../src/web/setup-checks";

afterEach(() => { clearSetupCheckCache(); vi.clearAllMocks(); vi.useRealTimers(); });

test("reuses settled setup checks when navigating back to a repository index", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
  const first = startSetupChecks("/work/example");
  const second = startSetupChecks("/work/example");
  assert.equal(second, first);
  assert.equal(checks.agents.mock.calls.length, 1);
  assert.equal(checks.github.mock.calls.length, 1);

  vi.advanceTimersByTime(5 * 60_000 + 1);
  assert.notEqual(startSetupChecks("/work/example"), first);
  assert.equal(checks.agents.mock.calls.length, 2);
});

test("keeps setup status isolated by repository", () => {
  const first = startSetupChecks("/work/one");
  const second = startSetupChecks("/work/two");
  assert.notEqual(second, first);
  assert.equal(checks.repository.mock.calls.length, 2);
});
