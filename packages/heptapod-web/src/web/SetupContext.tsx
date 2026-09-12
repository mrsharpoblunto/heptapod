"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AgentStatus } from "@thestraylight/heptapod-core/agents";
import type { ConnectedRepository } from "./connected-repository";
import type { GitHubStatus } from "./setup";

export interface SetupPromises {
  repository: Promise<ConnectedRepository>;
  github: Promise<GitHubStatus>;
  skills: Promise<boolean>;
  agents: Promise<{ agents: AgentStatus[]; error?: string }>;
}

const SetupContext = createContext<SetupPromises | null>(null);

// The root layout keeps these server-started promises across client navigation.
export function SetupProvider({ promises, children }: { promises: SetupPromises; children: ReactNode }) {
  return <SetupContext.Provider value={promises}>{children}</SetupContext.Provider>;
}

export function useSetupPromises(): SetupPromises {
  const promises = useContext(SetupContext);
  if (!promises) throw new Error("Setup checks require the root SetupProvider.");
  return promises;
}
