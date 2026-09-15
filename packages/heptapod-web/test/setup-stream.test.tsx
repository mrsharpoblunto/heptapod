import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { SetupProvider, type SetupPromises } from "../src/web/SetupContext";
import { SetupChecklist } from "../src/web/SetupChecklist";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));

const readyChecks = (): SetupPromises => ({
  client: Promise.resolve({ installed: true, version: "0.1.0" }),
  repository: Promise.resolve({ connected: true, name: "example/repo", githubUrl: "https://github.com/example/repo" }),
  difftastic: Promise.resolve({ installed: false }),
  github: Promise.resolve({ installed: true, authenticated: true }),
  skills: Promise.resolve(true),
  agents: Promise.resolve({ agents: [{ id: "codex", name: "Codex", installed: true, skillInstalled: true, installUrl: "https://example.com" }] }),
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
  assert.doesNotMatch(remounted, /Close setup checklist/);
  assert.doesNotMatch(remounted, /setup-disclosure|Expand setup checklist/);
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

test("Difftastic is optional and reports host availability with installation guidance", async () => {
  for (const difftastic of [{ installed: false }, { installed: true, version: "Difftastic 0.70.0" }]) {
    const output = new PassThrough(); let html = "";
    output.on("data", (chunk) => { html += chunk.toString(); });
    const ended = new Promise<void>((resolve, reject) => { output.on("end", resolve); output.on("error", reject); });
    const stream = renderToPipeableStream(createElement(SetupProvider, {
      promises: { ...readyChecks(), difftastic: Promise.resolve(difftastic) }, children: createElement(SetupChecklist),
    }), { onAllReady: () => stream.pipe(output), onError: (error) => { output.destroy(error as Error); } });
    await ended;
    assert.match(html, /Status OK/);
    assert.match(html, /Difftastic \(optional\)/);
    if (difftastic.installed) {
      assert.match(html, /Difftastic 0\.70\.0/);
      assert.doesNotMatch(html, /brew install difftastic/);
    } else {
      assert.match(html, /Reviews use standard diffs/);
      assert.match(html, /setup-optional/);
      assert.match(html, /brew install difftastic/);
      assert.match(html, /difft --version/);
    }
  }
});
