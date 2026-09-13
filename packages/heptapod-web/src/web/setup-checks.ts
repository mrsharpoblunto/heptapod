import { checkDifftastic } from "@thestraylight/heptapod-core/difftastic";
import { detectAgents } from "@thestraylight/heptapod-core/agents";
import { connectedRepository } from "./connected-repository";
import { checkGitHub, checkSkills } from "./setup";
import type { SetupPromises } from "./SetupContext";

export function startSetupChecks(): SetupPromises {
  const root = process.env.HEPTAPOD_ROOT ?? process.cwd();
  return {
    repository: connectedRepository(),
    github: checkGitHub(),
    skills: checkSkills(root),
    difftastic: checkDifftastic(root),
    agents: detectAgents(root).then((agents) => ({ agents }), (error: unknown) => ({
      agents: [], error: error instanceof Error ? error.message : "Check the agent settings in .heptapod.json.",
    })),
  };
}
