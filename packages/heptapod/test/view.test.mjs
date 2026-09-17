import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/tool/cli.js", import.meta.url));

test("view opens the requested web page through the CLI", { skip: process.platform === "win32" }, async (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "heptapod-view-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repo = join(temporary, "repository");
  const nested = join(repo, "nested");
  const bin = join(temporary, "bin");
  const state = join(temporary, "state");
  for (const directory of [nested, bin, state]) mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  const browserLog = join(temporary, "browser.json");
  const browser = join(bin, process.platform === "darwin" ? "open" : "xdg-open");
  writeFileSync(browser, `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.HEPTAPOD_TEST_BROWSER_LOG, JSON.stringify(process.argv.slice(2)));
if (process.env.HEPTAPOD_TEST_BROWSER_FAIL) { process.stderr.write("No browser available"); process.exitCode = 1; }
`);
  chmodSync(browser, 0o755);

  const registered = { id: "0123456789abcdef", root: repo, name: "owner/repository" };
  let repositories = [registered];
  const requests = [];
  const server = createServer((request, response) => {
    requests.push([request.method, request.url]);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/service/health") {
      response.end(JSON.stringify({ ready: true, ingestionProtocolVersion: 1, reviewPayloadSchemaVersion: 1 }));
    } else if (request.url === "/api/service/repositories") {
      response.end(JSON.stringify(repositories));
    } else {
      response.writeHead(404).end("{}");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const site = `http://localhost:${port}`;
  writeFileSync(join(state, "config.json"), JSON.stringify({ port }));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HEPTAPOD_STATE_DIR: state,
    HEPTAPOD_TEST_BROWSER_LOG: browserLog,
  };
  delete env.HEPTAPOD_API_URL;
  delete env.HEPTAPOD_TEST_BROWSER_FAIL;
  const invoke = (args, options = {}) => execute(process.execPath, [cli, "view", ...args], {
    cwd: temporary, env, timeout: 10_000, ...options,
  });

  const cases = [
    ["homepage outside a Git repository", [], temporary, "/"],
    ["current repository from a subdirectory", ["--repo"], nested, `/repositories/${registered.id}`],
    ["repository path", ["--repo", repo], temporary, `/repositories/${registered.id}`],
    ["registered repository name", ["--repo", registered.name], temporary, `/repositories/${registered.id}`],
    ["registered repository ID", ["--repo", registered.id], temporary, `/repositories/${registered.id}`],
    ["PR in current repository", ["--pr", "42"], nested, `/repositories/${registered.id}/reviews/42`],
    ["bare repo flag followed by PR", ["--repo", "--pr", "42"], nested, `/repositories/${registered.id}/reviews/42`],
    ["PR in named repository", ["--repo", registered.name, "--pr", "42"], temporary, `/repositories/${registered.id}/reviews/42`],
  ];
  for (const [name, args, cwd, path] of cases) {
    await t.test(name, async () => {
      const result = await invoke(args, { cwd });
      assert.deepEqual(JSON.parse(readFileSync(browserLog, "utf8")), [`${site}${path}`]);
      assert.ok(result.stdout.includes(`${site}${path}`));
    });
  }

  await t.test("service overrides and machine-readable output", async () => {
    const override = { ...env, HEPTAPOD_API_URL: "http://localhost:1/api/service" };
    const result = await invoke(["--service-port", String(port), "--output", "ndjson"], { env: override });
    assert.equal(JSON.parse(result.stdout).result.url, `${site}/`);
    await invoke(["--api-url", `http://127.0.0.1:${port}/api/service`]);
    assert.deepEqual(JSON.parse(readFileSync(browserLog, "utf8")), [`http://127.0.0.1:${port}/`]);
  });

  await t.test("invalid requests fail before opening a browser", async () => {
    const failures = [
      [["--pr"], /Missing value for --pr/],
      [["--pr", "0"], /positive pull request number/],
      [["--pr", "1/2"], /positive pull request number/],
      [["--repo", "missing-repository"], /not registered/],
      [["--unknown", "value"], /Unknown view option/],
    ];
    for (const [args, message] of failures) {
      rmSync(browserLog, { force: true });
      await assert.rejects(invoke(args), (error) => { assert.match(error.stderr, message); return true; });
      assert.equal(existsSync(browserLog), false);
    }
    repositories = [registered, { ...registered, id: "fedcba9876543210", root: "/another-checkout" }];
    await assert.rejects(invoke(["--repo", registered.name]), /ambiguous/);
    assert.equal(existsSync(browserLog), false);
    repositories = [];
    await assert.rejects(invoke(["--repo"], { cwd: nested }), /not registered/);
    assert.equal(existsSync(browserLog), false);
  });

  await t.test("browser failures show a usable URL", async () => {
    await assert.rejects(invoke([], { env: { ...env, HEPTAPOD_TEST_BROWSER_FAIL: "1" } }), (error) => {
      assert.match(error.stderr, /No browser available/);
      assert.ok(error.stderr.includes(`Open ${site}/ manually.`));
      return true;
    });
  });
  assert.ok(requests.every(([method]) => method === "GET"), "Viewing must not register or change repositories");
});
