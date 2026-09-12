import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { SetupProvider, type SetupPromises } from "../src/web/SetupContext";
import { SetupChecklist } from "../src/web/SetupChecklist";
import { OpenPullRequestsSection } from "../src/web/OpenPullRequestsSection";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));

const readyChecks = (): SetupPromises => ({
  repository: Promise.resolve({ connected: true, name: "example/repo", githubUrl: "https://github.com/example/repo" }),
  github: Promise.resolve({ installed: true, authenticated: true }),
  skills: Promise.resolve(true),
  agents: Promise.resolve({ agents: [{ id: "codex", name: "Codex", installed: true, authenticated: true, skillInstalled: true, loginCommand: "codex login", installUrl: "https://example.com" }] }),
});

test("streams each checklist check independently and reuses settled layout promises on remount", async () => {
  let finishSkills!: (value: boolean) => void;
  const promises = { ...readyChecks(), skills: new Promise<boolean>((resolve) => { finishSkills = resolve; }) };
  const view = () => createElement(SetupProvider, { promises, children: createElement(SetupChecklist) });
  const output = new PassThrough(); let html = "";
  output.on("data", (chunk) => { html += chunk.toString(); });
  const ended = new Promise<void>((resolve, reject) => { output.on("end", resolve); output.on("error", reject); });
  let shell!: () => void; const ready = new Promise<void>((resolve) => { shell = resolve; });
  const stream = renderToPipeableStream(view(), {
    onShellReady: () => { stream.pipe(output); shell(); },
    onError: (error) => { output.destroy(error as Error); },
  });
  await ready;
  assert.match(html, /Checking status/);
  assert.match(html, /Agent skills/);
  assert.match(html, /checking\.\.\./);
  finishSkills(true);
  await ended;
  assert.match(html, /Installed/);
  const remounted = renderToStaticMarkup(view());
  assert.doesNotMatch(remounted, /checking\.\.\.|progress-spinner/);
  assert.match(remounted, /example\/repo/);
  assert.match(remounted, /Authenticated/);
  assert.match(remounted, /Status OK/);
  assert.match(remounted, /aria-expanded="false"/);
  assert.match(remounted, /class="setup-panel" aria-hidden="true" inert=""/);
  assert.match(remounted, /Close setup checklist/);
  assert.doesNotMatch(remounted, /setup-disclosure|Expand setup checklist/);
});

test("PR discovery consumes the shared setup promises and remains hidden without an installed agent", async () => {
  const output = new PassThrough(); let html = "";
  output.on("data", (chunk) => { html += chunk.toString(); });
  const ended = new Promise<void>((resolve, reject) => { output.on("end", resolve); output.on("error", reject); });
  const stream = renderToPipeableStream(createElement(SetupProvider, {
    promises: { ...readyChecks(), agents: Promise.resolve({ agents: [] }) }, children: createElement(OpenPullRequestsSection, { importedIds: [], includeClosed: false }),
  }), { onAllReady: () => stream.pipe(output), onError: (error) => { output.destroy(error as Error); } });
  await ended;
  assert.equal(html, "");
});

test("reports a problem in the header when a completed check fails", async () => {
  const output = new PassThrough(); let html = "";
  output.on("data", (chunk) => { html += chunk.toString(); });
  const ended = new Promise<void>((resolve, reject) => { output.on("end", resolve); output.on("error", reject); });
  const stream = renderToPipeableStream(createElement(SetupProvider, {
    promises: { ...readyChecks(), skills: Promise.resolve(false) }, children: createElement(SetupChecklist),
  }), { onAllReady: () => stream.pipe(output), onError: (error) => { output.destroy(error as Error); } });
  await ended;
  assert.match(html, /Problem found/);
  assert.doesNotMatch(html, /Status OK/);
  assert.match(html, /heptapod-skill install/);
  assert.match(html, /aria-expanded="false"/);
});
