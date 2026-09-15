import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
const git = vi.hoisted(() => ({ repositoryRoot: vi.fn(), run: vi.fn() }));
vi.mock("../src/tool/git.js", () => ({ repositoryRoot: git.repositoryRoot }));
vi.mock("../src/tool/process.js", () => ({ run: git.run }));
import { findRepository, getRepository, listRepositories, registerRepository, removeRepository, repositoryDatabasePath } from "../src/tool/repositories.js";
import { githubRepositoryFromRemote } from "../src/tool/connected-repository.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("registers canonical repositories centrally using mocked Git metadata", () => {
  const state = mkdtempSync(join(tmpdir(), "heptapod-state-")); directories.push(state); vi.stubEnv("HEPTAPOD_STATE_DIR", state);
  const root = mkdtempSync(join(tmpdir(), "heptapod-repository-")); directories.push(root);
  git.repositoryRoot.mockReturnValue(root);
  git.run.mockReturnValue({ status: 0, stdout: Buffer.from("org-230620532@github.com:example/project.git\n"), stderr: Buffer.alloc(0) });
  const registered = registerRepository(root);
  assert.match(registered.id, /^[a-f\d]{16}$/);
  assert.equal(registered.root, realpathSync(root));
  assert.equal(registered.name, "example/project");
  assert.equal(registered.githubUrl, "https://github.com/example/project");
  assert.deepEqual(githubRepositoryFromRemote("org-230620532@github.com:example/project.git"), {
    name: "example/project", githubUrl: "https://github.com/example/project",
  });
  assert.deepEqual(findRepository(root), registered);
  assert.deepEqual(getRepository(registered.id), registered);
  assert.deepEqual(listRepositories(), [registered]);
  const reviews = repositoryDatabasePath(registered.id);
  assert.match(reviews, new RegExp(`${registered.id}/reviews\\.sqlite$`));
  assert.equal(removeRepository(registered.id), true);
  assert.equal(getRepository(registered.id), null);
  assert.equal(removeRepository(registered.id), false);
  assert.equal(registerRepository(root).id, registered.id);
});
