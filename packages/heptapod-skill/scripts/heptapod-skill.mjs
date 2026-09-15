#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = resolve(packageRoot, "skills/heptapod");

function usage() {
  return `heptapod-skill

Usage:
  heptapod-skill install
  heptapod-skill status
  heptapod-skill uninstall

Run the command from inside the target Git repository.
`;
}

function repositoryRoot() {
  if (process.env.HEPTAPOD_ROOT) return realpathSync(resolve(process.env.HEPTAPOD_ROOT));
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("run this command from inside the target Git repository");
  }
  return result.stdout.trim();
}

function targets(root) {
  return [
    { host: "Codex", path: resolve(root, ".agents/skills/heptapod") },
    { host: "Claude", path: resolve(root, ".claude/skills/heptapod") },
  ];
}

function entry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function pointsToPackagedSkill(path) {
  const metadata = entry(path);
  if (!metadata?.isSymbolicLink()) return false;
  try {
    return realpathSync(path) === realpathSync(skillSource);
  } catch {
    const target = resolve(dirname(path), readlinkSync(path));
    return target === skillSource;
  }
}

function install(root) {
  const destinations = targets(root);
  for (const target of destinations) {
    const metadata = entry(target.path);
    if (metadata && !pointsToPackagedSkill(target.path)) {
      throw new Error(`refusing to replace existing ${target.host} skill at ${target.path}`);
    }
  }
  for (const target of destinations) {
    if (pointsToPackagedSkill(target.path)) {
      process.stdout.write(`${target.host}: already linked at ${target.path}\n`);
      continue;
    }
    mkdirSync(dirname(target.path), { recursive: true });
    const linkTarget = process.platform === "win32"
      ? skillSource
      : relative(dirname(target.path), skillSource);
    symlinkSync(linkTarget, target.path, process.platform === "win32" ? "junction" : "dir");
    process.stdout.write(`${target.host}: linked ${target.path}\n`);
  }
}

function status(root) {
  let installed = true;
  for (const target of targets(root)) {
    const linked = pointsToPackagedSkill(target.path);
    installed &&= linked;
    process.stdout.write(`${target.host}: ${linked ? "linked" : "not linked"} (${target.path})\n`);
  }
  if (!installed) process.exitCode = 1;
}

function uninstall(root) {
  const destinations = targets(root);
  for (const target of destinations) {
    const metadata = entry(target.path);
    if (metadata && !pointsToPackagedSkill(target.path)) {
      throw new Error(`refusing to remove unrelated ${target.host} skill at ${target.path}`);
    }
  }
  for (const target of destinations) {
    if (!entry(target.path)) {
      process.stdout.write(`${target.host}: not installed\n`);
      continue;
    }
    unlinkSync(target.path);
    process.stdout.write(`${target.host}: removed ${target.path}\n`);
  }
}

try {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
  } else {
    const root = repositoryRoot();
    if (command === "install") install(root);
    else if (command === "status") status(root);
    else if (command === "uninstall") uninstall(root);
    else throw new Error(`unknown command: ${command}\n\n${usage()}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`heptapod-skill: ${message}\n`);
  process.exitCode = 1;
}
