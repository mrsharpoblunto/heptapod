#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skill = readFileSync(resolve(packageRoot, "skills/heptapod/SKILL.md"), "utf8");
const metadata = readFileSync(resolve(packageRoot, "skills/heptapod/agents/openai.yaml"), "utf8");
const plugin = JSON.parse(readFileSync(resolve(packageRoot, ".claude-plugin/plugin.json"), "utf8"));

if (!skill.startsWith("---\nname: heptapod\n")) throw new Error("SKILL.md must declare name: heptapod");
if (!skill.includes("references/artifact-format.md")) throw new Error("SKILL.md must link its artifact reference");
if (!metadata.includes("$heptapod")) throw new Error("OpenAI metadata must invoke $heptapod");
if (plugin.name !== "heptapod") throw new Error("Claude plugin name must be heptapod");

process.stdout.write("Heptapod skill package is valid.\n");
