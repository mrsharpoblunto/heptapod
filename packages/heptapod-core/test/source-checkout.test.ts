import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const git = vi.hoisted(() => ({ repositoryRoot: vi.fn(), resolveCommit: vi.fn(), run: vi.fn() }));
vi.mock("../src/tool/git.js", () => ({ repositoryRoot: git.repositoryRoot, resolveCommit: git.resolveCommit }));
vi.mock("../src/tool/process.js", () => ({ run: git.run }));

import { buildEditorLinks, ensureRevisionCheckout } from "../src/tool/source-checkout.js";
import type { RenderModel } from "../src/tool/types.js";

const directories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("editor links use mocked revision trees and preserve dirty checkouts", () => {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-editor-unit-"));
  directories.push(repo);
  const base = "a".repeat(40), head = "b".repeat(40);
  const state: { dirtyCheckout?: string } = {};
  git.repositoryRoot.mockImplementation((path: string) => path);
  git.resolveCommit.mockImplementation((_path: string, revision: string) => revision === "HEAD" ? head : revision);
  git.run.mockImplementation((_command: string, args: string[], options: { cwd?: string }) => {
    if (args[0] === "ls-tree") {
      const revision = args.at(-1);
      const paths = revision === head ? ["file # ü.ts", "new.ts"] : ["deleted.ts", "old.ts"];
      return { status: 0, stdout: Buffer.from(paths.map(path => `100644 blob deadbeef\t${path}`).join("\0") + "\0"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "status") {
      return { status: 0, stdout: Buffer.from(options.cwd === state.dirtyCheckout ? " M file.ts\n" : ""), stderr: Buffer.alloc(0) };
    }
    if (args.includes("worktree")) return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    throw new Error(`Unexpected mocked Git command: ${args.join(" ")}`);
  });
  const paths = ["file # ü.ts", "deleted.ts", "old.ts", "new.ts", "missing.ts"];
  const model = { source: { base, head, files: paths.map(path => ({ path, status: "M" })) }, steps: [] } as unknown as RenderModel;
  const links = buildEditorLinks(repo, model);
  assert.equal(links["file # ü.ts"].revision, head);
  assert.equal(links["file # ü.ts"].side, "head");
  assert.match(links["file # ü.ts"].url, /file%20%23%20%C3%BC.ts$/);
  assert.equal(links["deleted.ts"].revision, base);
  assert.equal(links["old.ts"].side, "base");
  assert.equal(links["new.ts"].side, "head");
  assert.equal(links["missing.ts"], undefined);

  const clean = ensureRevisionCheckout(repo, head);
  assert.equal(ensureRevisionCheckout(repo, head), clean);
  state.dirtyCheckout = clean;
  assert.notEqual(ensureRevisionCheckout(repo, head), clean);
});
