"use client";

import { agentDefinitions } from "./agent-definitions";
import { useReviewList } from "./ReviewListContext";

import { useToast } from "./Toasts";
import { ChevronDown, Import, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AgentStatus } from "@thestraylight/heptapod-core/agents";
import { AgentIcon } from "./AgentIcon";
import { ReviewHeader } from "./ReviewHeader";
import type { PullRequestPage } from "./setup";

export function PullRequestListHeader({ includeClosed }: { includeClosed: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <header className="pull-request-list-header">
    <h2 className="review-section-title">Pull requests</h2>
    <label className="pull-request-filter"><input key={String(includeClosed)} type="checkbox" defaultChecked={includeClosed} disabled={pending}
      onChange={(event) => { const checked = event.currentTarget.checked; startTransition(() => router.replace(checked ? "/?includeClosed=true" : "/", { scroll: false })); }} />
      Include closed and merged
    </label>
  </header>;
}

export function PullRequestEmptyState({ checking = false, includeClosed = false }: { checking?: boolean; includeClosed?: boolean }) {
  return <div className="empty-state pull-request-empty" role={checking ? "status" : undefined} aria-busy={checking || undefined}>
    {checking && <LoaderCircle className="progress-spinner" size={18} aria-hidden="true" />}
    <span>{checking ? "Checking for pull requests" : `No ${includeClosed ? "" : "open "}pull requests waiting to be imported.`}</span>
  </div>;
}

export function PullRequestLoadingSection({ includeClosed }: { includeClosed: boolean }) {
  return <section className="open-pull-requests" aria-label="Pull requests">
    <PullRequestListHeader includeClosed={includeClosed} />
    <PullRequestEmptyState checking />
  </section>;
}

export function PreparePullRequestButton({ number, agents, starting, onPrepare }: {
  number: number; agents: AgentStatus[]; starting: boolean; onPrepare: (number: number, agent: string) => void;
}) {
  const controlRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target) && dropdownRef.current) dropdownRef.current.open = false;
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);
  const available = agents.filter((agent) => agent.installed && agent.authenticated);
  const primary = available.find((agent) => agent.skillInstalled) ?? available[0];
  return <div className="prepare-pr-control" ref={controlRef}>
    <button className="prepare-pr-primary" disabled={starting || !primary?.skillInstalled}
      aria-label={primary ? `Import PR #${number} with ${agentDefinitions[primary.id].displayName}` : `Import PR #${number}`}
      title={primary ? primary.skillInstalled ? `Import with ${agentDefinitions[primary.id].displayName}` : `Install the ${agentDefinitions[primary.id].displayName} Heptapod skill` : "Install and authenticate an agent to prepare this PR"}
      onClick={() => { if (dropdownRef.current) dropdownRef.current.open = false; if (primary) onPrepare(number, primary.id); }}>
      <span className="prepare-pr-label">{starting ? "Importing…" : "Import"}</span>
      {starting ? <LoaderCircle className="prepare-pr-icon progress-spinner" size={20} aria-hidden="true" /> : <Import className="prepare-pr-icon" size={20} aria-hidden="true" />}
    </button>
    {available.length > 1 && <details ref={dropdownRef} onToggle={(event) => setOpen(event.currentTarget.open)} className="agent-picker" name="prepare-agent" onKeyDown={(event) => {
      if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
    }}>
      <summary aria-label={`Choose agent for PR #${number}`} aria-haspopup="menu"><ChevronDown className="prepare-pr-chevron" size={16} aria-hidden="true" />{starting ? <LoaderCircle className="prepare-pr-icon progress-spinner" size={20} aria-hidden="true" /> : <Import className="prepare-pr-icon" size={20} aria-hidden="true" />}</summary>
      <div className="agent-menu" role="menu" aria-label={`Import PR #${number} with`}>{available.map((agent) => <button key={agent.id} role="menuitem"
        disabled={starting || !agent.skillInstalled}
        onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onPrepare(number, agent.id); }}>
        <AgentIcon agent={agent.id} />{agentDefinitions[agent.id].displayName}{!agent.skillInstalled ? " · Install skill" : ""}
      </button>)}</div>
    </details>}
  </div>;
}

export function OpenPullRequests({ initialPage, importedIds, agents, includeClosed = false }: {
  initialPage: PullRequestPage; importedIds: string[]; agents: AgentStatus[]; includeClosed?: boolean;
}) {
  const router = useRouter();
  const list = useReviewList();
  const [starting, setStarting] = useState<number[]>([]);
  const notify = useToast();
  const [page, setPage] = useState(initialPage);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const imported = new Set(importedIds);
  const pullRequests = [...new Map([...page.pullRequests, ...initialPage.pullRequests].map((pr) => [pr.number, pr])).values()]
    .filter((pr) => !imported.has(String(pr.number)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const loadMore = useCallback(async () => {
    if (!page.hasNextPage || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoadingMore(true);
    setPageError(null);
    try {
      const query = new URLSearchParams({ includeClosed: String(includeClosed), cursor: page.endCursor ?? "" });
      const response = await fetch(`/api/pull-requests?${query}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "Could not load more pull requests.");
      }
      const next = await response.json() as PullRequestPage;
      if (next.hasNextPage && (!next.endCursor || next.endCursor === page.endCursor)) throw new Error("Could not advance to the next page of pull requests.");
      if (!controller.signal.aborted) setPage((current) => ({ ...next, pullRequests: [...current.pullRequests, ...next.pullRequests] }));
    } catch (error) {
      if (!controller.signal.aborted) { const message = error instanceof Error ? error.message : String(error); setPageError(message); notify(message); }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [includeClosed, page.endCursor, page.hasNextPage, notify]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => {
    if (!page.hasNextPage || pageError || loadingMore || !sentinel.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "300px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loadMore, loadingMore, page.hasNextPage, pageError]);
  const prepare = async (number: number, agent: string) => {
    setStarting((current) => [...current, number]);
    try {
      const response = await fetch("/api/service/reviews/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number, agent }) });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "Could not prepare the review.");
      }
      if (list) list.refresh();
      else router.refresh();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : String(caught));
    } finally { setStarting((current) => current.filter((id) => id !== number)); }
  };
  return <section className="open-pull-requests" aria-label="Pull requests">
    <PullRequestListHeader includeClosed={includeClosed} />
    {pullRequests.length === 0 && !page.hasNextPage ? <PullRequestEmptyState includeClosed={includeClosed} /> : <div className="review-list">
      {pullRequests.map((pr) => <article key={pr.number} className="review-list-item open-pr-item">
        <div className="review-list-content"><ReviewHeader compact metadata={pr.metadata} actions={<PreparePullRequestButton number={pr.number} agents={agents} starting={starting.includes(pr.number)} onPrepare={(number, agent) => void prepare(number, agent)} />} review={{
          id: String(pr.number), title: pr.title, summary: "", sourceUrl: pr.url,
          baseRevision: pr.baseRevision, headRevision: pr.headRevision, updatedAt: pr.createdAt, additions: pr.additions, deletions: pr.deletions,
        }} /></div>
      </article>)}
    </div>}
    {page.hasNextPage && <div ref={sentinel} className="pull-request-pagination">
      <button disabled={loadingMore} onClick={() => void loadMore()}>
        {loadingMore && <LoaderCircle className="progress-spinner" size={16} aria-hidden="true" />}
        {loadingMore ? "Loading pull requests…" : pageError ? "Retry loading pull requests" : "Load more pull requests"}
      </button>
    </div>}
  </section>;
}
