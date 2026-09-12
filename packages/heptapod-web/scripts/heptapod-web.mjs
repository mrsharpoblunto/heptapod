#!/usr/bin/env node
import { fork, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const development = args[0] === "--dev";
const nextArguments = development ? args.slice(1) : args;
function option(names, fallback) {
  const index = nextArguments.findIndex((arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)));
  return index < 0 ? fallback : nextArguments[index].includes("=") ? nextArguments[index].split("=").slice(1).join("=") : nextArguments[index + 1];
}
const port = Number(option(["--port", "-p"], process.env.PORT ?? "3000"));
const apiPort = development ? port + 1 : Number(process.env.HEPTAPOD_API_PORT ?? port + 1);
if (!Number.isInteger(port) || port < 1 || port > 65534 || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535 || port === apiPort) {
  throw new Error("Choose valid, distinct web and API ports.");
}
const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
const root = process.env.HEPTAPOD_ROOT ?? (git.status === 0 ? git.stdout.trim() : process.cwd());
const apiEntrypoint = fileURLToPath(import.meta.resolve("@thestraylight/heptapod-api/server"));
// Workspace development builds shared APIs before starting either harness.
if (development) {
  const apiRoot = resolve(dirname(apiEntrypoint), "..");
  const coreRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@thestraylight/heptapod-core"))), "../..");
  for (const directory of [coreRoot, apiRoot]) {
    if (!existsSync(resolve(directory, "src"))) continue;
    const localRequire = createRequire(resolve(directory, "package.json"));
    const built = spawnSync(process.execPath, [localRequire.resolve("typescript/bin/tsc"), "-p", resolve(directory, "tsconfig.json")], { stdio: "inherit" });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
}
const hostname = option(["--hostname", "-H"], "localhost");
const env = { ...process.env, HEPTAPOD_ROOT: root, HEPTAPOD_API_PORT: String(apiPort),
  HEPTAPOD_API_URL: `http://127.0.0.1:${apiPort}`, HEPTAPOD_WEB_ORIGIN: `http://${hostname}:${port}` };
const api = fork(resolve(dirname(apiEntrypoint), "cli.js"), [], { env, stdio: ["inherit", "inherit", "inherit", "ipc"] });
let web;
let stopping = false;
function stop(signal = "SIGTERM") { stopping = true; web?.kill(signal); api.kill(signal); }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop(signal));
api.once("error", (error) => { process.stderr.write(`Heptapod API: ${error.message}\n`); stop(); process.exitCode = 1; });
api.once("exit", (code) => { if (!stopping) { stop(); process.exitCode = code || 1; } });
api.once("message", (message) => {
  if (!message?.ready || stopping) return;
  web = spawn(process.execPath, [require.resolve("next/dist/bin/next"), development ? "dev" : "start", packageRoot, "--port", String(port), ...nextArguments], { env, stdio: "inherit" });
  web.once("error", (error) => { process.stderr.write(`Heptapod web: ${error.message}\n`); stop(); process.exitCode = 1; });
  web.once("exit", (code) => { stop(); process.exitCode = code ?? 1; });
});
