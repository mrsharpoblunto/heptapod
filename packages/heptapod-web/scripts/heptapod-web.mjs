#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextCli = require.resolve("next/dist/bin/next");
const cliArguments = process.argv.slice(2);
const development = cliArguments[0] === "--dev";
const nextArguments = development ? cliArguments.slice(1) : cliArguments;
const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  encoding: "utf8",
});

if (gitRoot.status !== 0 || !gitRoot.stdout.trim()) {
  process.stderr.write("heptapod-web: run this command from inside the target Git repository.\n");
  process.exit(gitRoot.status ?? 1);
}

const result = spawnSync(
  process.execPath,
  [nextCli, development ? "dev" : "start", packageRoot, ...nextArguments],
  {
    env: {
      ...process.env,
      HEPTAPOD_ROOT: gitRoot.stdout.trim(),
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
