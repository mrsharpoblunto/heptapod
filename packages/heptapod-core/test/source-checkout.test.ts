import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { buildEditorLinks, ensureRevisionCheckout } from "../src/tool/source-checkout.js";
import type { RenderModel } from "../src/tool/types.js";

test("editor links use pinned files, preserve working edits, and reuse only clean checkouts", () => {
  const repo = mkdtempSync(join(tmpdir(), "heptapod-editor-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString("utf8").trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, "file # ü.ts"), "base\n");
    writeFileSync(join(repo, "deleted.ts"), "deleted at head\n");
    writeFileSync(join(repo, "old.ts"), "renamed file\n");
    symlinkSync("file # ü.ts", join(repo, "link.ts"));
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("mv", "old.ts", "new.ts");
    git("rm", "deleted.ts");
    writeFileSync(join(repo, "file # ü.ts"), "head\n");
    git("add", ".");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "file # ü.ts"), "uncommitted edits\n");
    const paths = ["file # ü.ts", "deleted.ts", "old.ts", "new.ts", "missing.ts", "link.ts", "../outside.ts"];
    const model = {
      source: { base, head, files: paths.map((path) => ({ path, status: "M" })) }, steps: [],
    } as unknown as RenderModel;
    const links = buildEditorLinks(repo, model);
    assert.equal(links["file # ü.ts"].revision, head);
    assert.equal(links["file # ü.ts"].side, "head");
    assert.match(links["file # ü.ts"].url, /^vscode:\/\/file\//);
    assert.match(links["file # ü.ts"].url, /file%20%23%20%C3%BC.ts$/);
    assert.equal(readFileSync(decodeURIComponent(new URL(links["file # ü.ts"].url).pathname), "utf8"), "head\n");
    assert.equal(links["deleted.ts"].revision, base);
    assert.equal(links["deleted.ts"].side, "base");
    assert.equal(readFileSync(decodeURIComponent(new URL(links["deleted.ts"].url).pathname), "utf8"), "deleted at head\n");
    assert.equal(links["old.ts"].revision, base);
    assert.equal(links["new.ts"].revision, head);
    assert.equal(links["missing.ts"], undefined);
    assert.equal(links["link.ts"], undefined);
    assert.equal(links["../outside.ts"], undefined);
    assert.deepEqual(buildEditorLinks(repo, model), links);
    const checkout = ensureRevisionCheckout(repo, head);
    writeFileSync(join(checkout, "file # ü.ts"), "editor edits\n");
    const fresh = ensureRevisionCheckout(repo, head);
    assert.notEqual(fresh, checkout);
    assert.equal(readFileSync(join(fresh, "file # ü.ts"), "utf8"), "head\n");
    assert.equal(readFileSync(join(checkout, "file # ü.ts"), "utf8"), "editor edits\n");
    assert.equal(readFileSync(join(repo, "file # ü.ts"), "utf8"), "uncommitted edits\n");
    assert.equal(git("rev-parse", "HEAD"), head);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
