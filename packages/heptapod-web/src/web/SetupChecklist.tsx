"use client";

import { agentDefinitions } from "./agent-definitions";

import { AgentIcon } from "./AgentIcon";
import { Suspense, use, useId, useRef, useState, type ReactNode } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import type { ConnectedRepository } from "./connected-repository";
import type { GitHubStatus } from "./setup";
import { useSetupPromises, type SetupPromises } from "./SetupContext";

function Item({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return <li className={`setup-item ${ok === undefined ? "setup-checking" : ok ? "setup-ok" : "setup-missing"}`} aria-busy={ok === undefined || undefined}>
    {ok === undefined ? <LoaderCircle size={18} className="progress-spinner" aria-label="Checking" /> : ok ? <Check size={18} aria-label="Passed" /> : <X size={18} aria-label="Not ready" />}<div>{children}</div>
  </li>;
}
export function CheckingItem({ label }: { label: string }) {
  return <Item><strong>{label}:</strong> <span>checking...</span></Item>;
}
function RepositoryCheck({ promise }: { promise: Promise<ConnectedRepository> }) {
  const repo = use(promise);
  return <Item ok={repo.connected}><strong>Git repository:</strong> {repo.githubUrl ? <a href={repo.githubUrl} target="_blank" rel="noreferrer">{repo.name}</a> : <span>{repo.name}</span>}
    {!repo.connected && <p>Clone or initialize a Git repository, then run <code>pnpm exec heptapod-web</code> from inside it.</p>}
    {repo.connected && !repo.githubUrl && <p>Connect a GitHub origin to list pull requests: <code>git remote add origin &lt;github-repository-url&gt;</code>.</p>}
  </Item>;
}
function GitHubCheck({ promise }: { promise: Promise<GitHubStatus> }) {
  const status = use(promise);
  return <Item ok={status.authenticated}><strong>GitHub CLI:</strong> <span>{status.authenticated ? "Authenticated" : status.installed ? "Not authenticated" : "Not installed"}</span>
    {!status.authenticated && <><p>{!status.installed && <>Install <a href="https://cli.github.com/" target="_blank" rel="noreferrer">GitHub CLI</a>, then </>}Run <code>gh auth login</code> and verify with <code>gh auth status</code>.</p><p>Without authentication, PR discovery and import, GitHub avatars and evidence, and publishing review drafts will not work.</p></>}
  </Item>;
}
function SkillsCheck({ promise }: { promise: Promise<boolean> }) {
  const installed = use(promise);
  return <Item ok={installed}><strong>Agent skills:</strong> <span>{installed ? "Installed" : "Not installed"}</span>
    {!installed && <p>Install <code>pnpm add -D @thestraylight/heptapod-skill</code>, then run <code>pnpm exec heptapod-skill install</code> in this repository to enable narrative preparation for Codex and Claude Code.</p>}
  </Item>;
}
function AgentsCheck({ promise }: { promise: SetupPromises["agents"] }) {
  const { agents, error } = use(promise);
  if (error) return <Item ok={false}><strong>Agents:</strong> <span>Unable to check</span><p>{error}</p></Item>;
  const ready = agents.filter((agent) => agent.authenticated);
  return <Item ok={ready.length > 0}><strong>Agents:</strong> <span className="setup-agents">{ready.length ? ready.map((agent) => <span className="setup-agent" key={agent.id}><AgentIcon agent={agent.id} />{agentDefinitions[agent.id].displayName}</span>) : "None available"}</span>
    {agents.filter((agent) => !agent.authenticated).map((agent) => <p key={agent.id}><span className="setup-agent"><AgentIcon agent={agent.id} />{agentDefinitions[agent.id].displayName}</span>: {agent.installed ? "not authenticated" : <><a href={agent.installUrl} target="_blank" rel="noreferrer">install CLI</a></>}. Sign in with <code>{agent.loginCommand}</code>.</p>)}
    {!ready.length && <p>Install and authenticate an agent to prepare reviews from the open PR list.</p>}
  </Item>;
}
function ChecklistItems({ promises: { repository, github, skills, agents } }: { promises: SetupPromises }) {
  return <ul className="setup-checklist">
    <Suspense fallback={<CheckingItem label="Git repository" />}><RepositoryCheck promise={repository} /></Suspense>
    <Suspense fallback={<CheckingItem label="GitHub CLI" />}><GitHubCheck promise={github} /></Suspense>
    <Suspense fallback={<CheckingItem label="Agent skills" />}><SkillsCheck promise={skills} /></Suspense>
    <Suspense fallback={<CheckingItem label="Agents" />}><AgentsCheck promise={agents} /></Suspense>
  </ul>;
}
function CompletedStatus({ promises }: { promises: SetupPromises }) {
  const repository = use(promises.repository);
  const github = use(promises.github);
  const skills = use(promises.skills);
  const agents = use(promises.agents);
  const ok = repository.connected && github.authenticated && skills && !agents.error && agents.agents.some((agent) => agent.authenticated);
  return <>{ok ? <Check size={16} className="setup-status-ok" aria-hidden="true" /> : <X size={16} className="setup-status-problem" aria-hidden="true" />}<span>{ok ? "Status OK" : "Problem found"}</span></>;
}
export function SetupChecklist() {
  const promises = useSetupPromises();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dismiss = () => { setExpanded(false); trigger.current?.focus(); };
  return <>
    <button ref={trigger} type="button" className="setup-status" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={panelId}>
      <span className="setup-status-label" aria-live="polite"><Suspense fallback={<><LoaderCircle size={16} className="progress-spinner" aria-hidden="true" /><span>Checking status</span></>}>
        <CompletedStatus promises={promises} />
      </Suspense></span>
    </button>
    <div id={panelId} className={`setup-panel${expanded ? " setup-panel-open" : ""}`} aria-hidden={!expanded} inert={!expanded}><div className="setup-panel-content">
    <section className="ingestion-help setup-details" aria-label="Setup checklist" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); dismiss(); } }}>
      <button type="button" className="setup-dismiss" aria-label="Close setup checklist" onClick={dismiss}><X size={18} aria-hidden="true" /></button>
      <ChecklistItems promises={promises} />
    </section>
    </div></div>
  </>;
}
