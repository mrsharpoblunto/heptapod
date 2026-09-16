#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = [
  "@thestraylight/heptapod-core",
  "@thestraylight/heptapod-web",
  "@thestraylight/heptapod",
  "@thestraylight/heptapod-skill",
];
const registry = "https://registry.npmjs.org";

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`);
  }
  return result.stdout.trim();
}

function packedManifest(archive) {
  return JSON.parse(run("tar", ["-xOf", archive, "package/package.json"]));
}

function assertPublishableManifest(manifest) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (/^(?:workspace|file|link):/.test(String(range))) {
        throw new Error(`${manifest.name} retains non-publishable ${field}.${name}: ${range}`);
      }
      if (packages.includes(name) && range !== `^${manifest.version}`) {
        throw new Error(`${manifest.name} must depend on ${name} at ^${manifest.version}, received ${range}.`);
      }
    }
  }
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a port for the packaged website check."));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function assertWebsite(consumer) {
  const port = await availablePort();
  const launcher = join(consumer, "node_modules", "@thestraylight", "heptapod-web", "scripts", "heptapod-web.mjs");
  const child = spawn(process.execPath, [launcher, "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: consumer,
    env: { ...process.env, HEPTAPOD_STATE_DIR: join(consumer, "state") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const appendOutput = (chunk) => { output = `${output}${chunk}`.slice(-65_536); };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  let exited = false;
  const exit = new Promise((resolveExit) => child.once("exit", (code, signal) => {
    exited = true;
    resolveExit({ code, signal });
  }));
  let failure;
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exited) throw new Error("The packaged website exited before accepting requests.");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
        const body = await response.text();
        if (!response.ok) throw new Error(`The packaged website returned HTTP ${response.status}: ${body}`);
        if (!/Heptapod/i.test(body)) throw new Error("The packaged website response did not contain the Heptapod page.");
        return;
      } catch (error) {
        if (error instanceof Error && /returned HTTP|did not contain/.test(error.message)) throw error;
        await delay(100);
      }
    }
    throw new Error("The packaged website did not become ready within 20 seconds.");
  } catch (error) {
    failure = error;
  } finally {
    if (!exited) child.kill("SIGTERM");
    await Promise.race([exit, delay(5_000)]);
  }
  if (failure) {
    const detail = output.trim();
    throw new Error(`${failure instanceof Error ? failure.message : String(failure)}${detail ? `\n${detail}` : ""}`);
  }
}

async function assertInstalled(consumer, expectedVersion) {
  for (const name of packages) {
    const manifest = JSON.parse(readFileSync(join(consumer, "node_modules", ...name.split("/"), "package.json"), "utf8"));
    if (manifest.version !== expectedVersion) {
      throw new Error(`${name} installed at ${manifest.version}; expected ${expectedVersion}.`);
    }
  }
  run(process.execPath, [join(consumer, "node_modules", "@thestraylight", "heptapod", "scripts", "heptapod.mjs"), "--help"], consumer);
  await assertWebsite(consumer);
}

const temporary = mkdtempSync(join(tmpdir(), "heptapod-install-check-"));
try {
  const archives = join(temporary, "archives");
  mkdirSync(archives);
  const packed = [];
  for (const name of packages) {
    const before = new Set(readdirSync(archives));
    run("pnpm", ["--filter", name, "pack", "--pack-destination", archives]);
    const created = readdirSync(archives).filter((file) => file.endsWith(".tgz") && !before.has(file));
    if (created.length !== 1) throw new Error(`Packing ${name} created ${created.length} archives; expected one.`);
    const archive = join(archives, created[0]);
    const manifest = packedManifest(archive);
    if (manifest.name !== name) throw new Error(`Packed ${manifest.name ?? "an unnamed package"}; expected ${name}.`);
    assertPublishableManifest(manifest);
    packed.push({ archive, manifest });
  }
  const versions = new Set(packed.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) throw new Error(`Packed package versions are not aligned: ${[...versions].join(", ")}.`);
  const version = packed[0].manifest.version;
  const archivePaths = packed.map(({ archive }) => archive);
  for (const manager of ["npm", "pnpm"]) {
    const consumer = join(temporary, manager);
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: `heptapod-${manager}-install-check`, private: true }, null, 2)}\n`);
    if (manager === "npm") {
      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`, ...archivePaths], consumer);
    } else {
      run("pnpm", ["add", "--ignore-scripts", `--registry=${registry}`, ...archivePaths], consumer);
    }
    await assertInstalled(consumer, version);
    process.stdout.write(`${manager} install check passed for Heptapod ${version}.\n`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
