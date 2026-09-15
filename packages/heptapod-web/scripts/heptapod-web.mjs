#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
function withoutOptions(values, names) {
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (names.includes(value)) { index += 1; continue; }
    if (names.some((name) => value.startsWith(`${name}=`))) continue;
    result.push(value);
  }
  return result;
}
function servicePort() {
  const state = process.env.HEPTAPOD_STATE_DIR ?? (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Heptapod")
    : process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Heptapod")
      : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "heptapod"));
  try {
    const value = JSON.parse(readFileSync(join(state, "config.json"), "utf8")).port;
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("invalid port");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return 49731;
    throw new Error(`Invalid Heptapod service config: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const configuredPort = servicePort();
const port = Number(option(["--port", "-p"], process.env.PORT ?? String(development ? 3000 : configuredPort)));
const hostname = option(["--hostname", "-H"], "localhost");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Choose a valid web service port.");
if (!hostname) throw new Error("Choose a valid web service hostname.");
// Workspace development builds the shared core API before starting Next.
if (development) {
  const coreRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@thestraylight/heptapod-core"))), "../..");
  for (const directory of [coreRoot]) {
    if (!existsSync(resolve(directory, "src"))) continue;
    const localRequire = createRequire(resolve(directory, "package.json"));
    const built = spawnSync(process.execPath, [localRequire.resolve("typescript/bin/tsc"), "-p", resolve(directory, "tsconfig.json")], { stdio: "inherit" });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
}
const forwardedArguments = withoutOptions(nextArguments, ["--port", "-p", "--hostname", "-H"]);
const web = spawn(process.execPath, [require.resolve("next/dist/bin/next"), development ? "dev" : "start", packageRoot,
  "--port", String(port), "--hostname", hostname, ...forwardedArguments], { env: process.env, stdio: "inherit" });
function stop(signal = "SIGTERM") { web.kill(signal); }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop(signal));
web.once("error", (error) => { process.stderr.write(`Heptapod web: ${error.message}\n`); process.exitCode = 1; });
web.once("exit", (code) => { process.exitCode = code ?? 1; });
