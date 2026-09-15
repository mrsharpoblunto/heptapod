#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const manifests = [
  "package.json",
  "packages/heptapod-core/package.json",
  "packages/heptapod-web/package.json",
  "packages/heptapod/package.json",
  "packages/heptapod-skill/package.json",
];
const publishOrder = [
  "@thestraylight/heptapod-core",
  "@thestraylight/heptapod-web",
  "@thestraylight/heptapod",
  "@thestraylight/heptapod-skill",
];

function usage() {
  return `Usage: pnpm release -- <patch|minor|major> [--plan] [--dry-run] [--tag <tag>] [--otp <code>] [--yes]

Examples:
  pnpm release -- minor --plan
  pnpm release -- minor --dry-run
  pnpm release -- minor
  pnpm release -- patch --tag next
`;
}

function parseArguments(argv) {
  const options = { dryRun: false, plan: false, yes: false, tag: "latest", otp: undefined, target: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--dry-run") options.dryRun = true;
    else if (value === "--plan") options.plan = true;
    else if (value === "--yes") options.yes = true;
    else if (value === "--tag" || value === "--otp") {
      const argument = argv[++index];
      if (!argument) throw new Error(`${value} requires a value.\n\n${usage()}`);
      options[value.slice(2)] = argument;
    } else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}\n\n${usage()}`);
    else if (options.target) throw new Error(`Unexpected argument: ${value}\n\n${usage()}`);
    else options.target = value;
  }
  if (!options.target) throw new Error(usage());
  if (!["patch", "minor", "major"].includes(options.target)) throw new Error(`Release type must be patch, minor, or major.\n\n${usage()}`);
  if (options.plan && options.dryRun) throw new Error("Choose either --plan or --dry-run, not both.");
  return options;
}

function parseVersion(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Invalid version: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const aPart = aParts[index];
    const bPart = bParts[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNumber = /^\d+$/.test(bPart) ? Number(bPart) : null;
    if (aNumber !== null && bNumber !== null) return aNumber < bNumber ? -1 : 1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function nextVersion(current, target) {
  const version = parseVersion(current);
  if (target === "major") return `${version.major + 1}.0.0`;
  if (target === "minor") return `${version.major}.${version.minor + 1}.0`;
  if (version.prerelease) return `${version.major}.${version.minor}.${version.patch}`;
  return `${version.major}.${version.minor}.${version.patch + 1}`;
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(capture ? result.stderr.trim() || `${command} failed.` : `${command} ${args.join(" ")} failed.`);
  return capture ? result.stdout.trim() : "";
}

function publishedVersions(name) {
  const result = spawnSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8" });
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    return (Array.isArray(value) ? value : value ? [value] : []).sort(compareVersions);
  }
  if (/E404|404 Not Found/.test(result.stderr)) return false;
  throw new Error(result.stderr.trim() || `Could not query ${name}.`);
}

function releasePlan(releaseType) {
  const registry = publishOrder.map((name) => {
    const versions = publishedVersions(name) || [];
    return { name, versions, latest: versions.at(-1) };
  });
  const registryStates = new Set(registry.map(({ latest }) => latest ?? "unpublished"));
  const commonVersions = registry[0].versions.filter((version) => registry.every((entry) => entry.versions.includes(version)));
  const base = commonVersions.at(-1) ?? "0.0.0";
  const target = nextVersion(base, releaseType);
  const highestPublished = registry.map(({ latest }) => latest).filter(Boolean).sort(compareVersions).at(-1);
  const resuming = registryStates.size > 1;
  if (resuming && highestPublished !== target) {
    throw new Error(`Published package versions are out of sync (${[...registryStates].join(", ")}), and ${releaseType} from their last common version ${base} would be ${target}. Finish or repair the inconsistent release before starting another.`);
  }
  for (const entry of registry) {
    if (entry.latest && compareVersions(target, entry.latest) < 0) {
      throw new Error(`Calculated target ${target} is older than ${entry.name}'s latest published version ${entry.latest}.`);
    }
  }
  return {
    base,
    target,
    resuming,
    packages: registry.map((entry) => ({ ...entry, published: entry.versions.includes(target) })),
  };
}

function writeVersions(version) {
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = version;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

async function confirm(message) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/i.test((await prompt.question(`${message} [y/N] `)).trim()); }
  finally { prompt.close(); }
}

async function main() {
  if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
    process.stdout.write(usage());
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  const loaded = manifests.map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) }));
  const versions = new Set(loaded.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) throw new Error(`Workspace versions are not aligned: ${[...versions].join(", ")}`);
  const current = loaded[0].manifest.version;

  if (!options.dryRun && !options.plan) {
    if (run("git", ["status", "--porcelain"], true)) throw new Error("Commit or stash all working-tree changes before publishing.");
    const user = run("npm", ["whoami"], true);
    process.stdout.write(`npm user: ${user}\n`);
  }
  const plan = releasePlan(options.target);
  const version = plan.target;
  if (compareVersions(current, plan.base) < 0) throw new Error(`Workspace version ${current} is behind the released base ${plan.base}.`);
  if (compareVersions(current, version) > 0) throw new Error(`Workspace version ${current} is ahead of the calculated target ${version}.`);
  process.stdout.write(`Heptapod ${options.target} release ${plan.base} → ${version}${plan.resuming ? " (resume partial release)" : ""}${options.plan ? " (plan)" : options.dryRun ? " (dry run)" : ""}\n`);
  const unpublished = plan.packages.filter(({ published }) => !published).map(({ name }) => name);
  process.stdout.write("Registry plan:\n");
  for (const entry of plan.packages) {
    process.stdout.write(`  ${entry.name}: ${entry.latest ?? "unpublished"} → ${entry.published ? `${version} (already published; skip)` : version}\n`);
  }
  if (!unpublished.length) throw new Error(`All packages are already published at ${version}.`);
  if (options.plan) {
    process.stdout.write("Release plan is valid. No files were changed and nothing was published.\n");
    return;
  }

  if (options.dryRun) {
    run("pnpm", ["check"]);
    run("pnpm", ["pack:check"]);
    process.stdout.write(`Dry run complete. No versions were changed and nothing was published.\n`);
    return;
  }

  process.stdout.write(`Packages: ${unpublished.join(", ")}\nTag: ${options.tag}\n`);
  if (!options.yes) {
    if (!process.stdin.isTTY || !await confirm(`Publish ${unpublished.length} package${unpublished.length === 1 ? "" : "s"} at ${version}?`)) {
      process.stdout.write("Release cancelled.\n");
      return;
    }
  }

  run("pnpm", ["check"]);
  if (version !== current) writeVersions(version);
  run("pnpm", ["pack:check"]);
  for (const name of publishOrder) {
    if (!unpublished.includes(name)) continue;
    const args = ["--filter", name, "publish", "--access", "public", "--tag", options.tag, "--no-git-checks"];
    if (options.otp) args.push("--otp", options.otp);
    run("pnpm", args);
  }
  process.stdout.write(`Published Heptapod ${version}. Commit the version files and tag the release with: git tag v${version}\n`);
}

main().catch((error) => {
  process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
