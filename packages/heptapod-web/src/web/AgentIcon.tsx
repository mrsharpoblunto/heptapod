import type { AgentId } from "@thestraylight/heptapod-core/agents";
import { agentDefinitions } from "./agent-definitions";

export function AgentIcon({ agent, size = 16 }: { agent: AgentId; size?: number }) {
  const definition = agentDefinitions[agent];
  return <svg className="agent-icon" width={size} height={size} viewBox="0 0 24 24" fill={definition.icon.color} aria-hidden="true">
    <path d={definition.icon.path} fillRule="evenodd" clipRule="evenodd" />
  </svg>;
}
