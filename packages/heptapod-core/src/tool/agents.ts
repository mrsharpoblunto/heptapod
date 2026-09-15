import { agentPreferences, readConfigFile } from "./config-file.js";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const supportedAgents = [
  { id: "codex", name: "Codex", skillPath: ".agents/skills/heptapod/SKILL.md", installUrl: "https://developers.openai.com/codex/cli/" },
  { id: "claude", name: "Claude Code", skillPath: ".claude/skills/heptapod/SKILL.md", installUrl: "https://code.claude.com/docs/en/setup" },
] as const;
export type AgentId = typeof supportedAgents[number]["id"];
export interface AgentStatus {
  id: AgentId;
  name: string;
  installed: boolean;
  skillInstalled: boolean;
  installUrl: string;
}
export async function agentSkillInstalled(root: string, skillPath: string): Promise<boolean> {
  try { await access(join(root, skillPath)); return true; } catch { return false; }
}
export async function detectAgents(root: string): Promise<AgentStatus[]> {
  const detected = await Promise.all(supportedAgents.map(async (agent) => {
    const status: AgentStatus = { ...agent, installed: false, skillInstalled: await agentSkillInstalled(root, agent.skillPath) };
    const options = { cwd: root, timeout: 5_000, maxBuffer: 64 * 1024 };
    try { await execute(agent.id, ["--version"], options); status.installed = true; } catch { return status; }
    return status;
  }));
  const preferences = agentPreferences(readConfigFile(root));
  const order = [...preferences, ...supportedAgents.map((agent) => agent.id).filter((id) => !preferences.includes(id))];
  return detected.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
export function agentArguments(id: AgentId, prompt: string, metadataDirectory: string): string[] {
  return id === "codex"
    ? ["exec", "--sandbox", "workspace-write", "--add-dir", metadataDirectory, prompt]
    : ["--print", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash(git diff *),Bash(git show *),Bash(git check-attr *),Bash(gh api *),Bash(pnpm exec heptapod validate *)", "--", prompt];
}
