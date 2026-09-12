"use client";

import { use, useEffect, useState } from "react";
import { useToast } from "./Toasts";
import type { AgentStatus } from "@thestraylight/heptapod-core/agents";
import type { PullRequestPage } from "./setup";
import { useSetupPromises } from "./SetupContext";
import { useReviewList } from "./ReviewListContext";
import { OpenPullRequests, PullRequestListHeader, PullRequestLoadingSection } from "./OpenPullRequests";

export function OpenPullRequestsSection({ importedIds, includeClosed }: { importedIds: string[]; includeClosed: boolean }) {
  const promises = useSetupPromises();
  const list = useReviewList();
  const { agents } = use(promises.agents);
  const repo = use(promises.repository);
  const github = use(promises.github);
  if (!agents.some((agent) => agent.installed)) return null;
  if (!repo.githubUrl || !github.authenticated) return <section className="open-pull-requests"><PullRequestListHeader includeClosed={includeClosed} /><p className="empty-state">Connect a GitHub repository and authenticate GitHub CLI to load open pull requests.</p></section>;
  return <PullRequestPageLoader key={`${repo.name}:${includeClosed}`} importedIds={list ? list.reviews.map((review) => review.id) : importedIds} includeClosed={includeClosed} agents={agents} />;
}

function PullRequestPageLoader({ importedIds, includeClosed, agents }: { importedIds: string[]; includeClosed: boolean; agents: AgentStatus[] }) {
  const notify = useToast();
  const [page, setPage] = useState<PullRequestPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/pull-requests?includeClosed=${includeClosed}`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load pull requests.");
      if (!controller.signal.aborted) setPage(result as PullRequestPage);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setFailed(true);
        notify(error instanceof Error ? error.message : "Could not load pull requests.");
      }
    });
    return () => controller.abort();
  }, [includeClosed, attempt, notify]);
  if (page) return <OpenPullRequests initialPage={page} importedIds={importedIds} agents={agents} includeClosed={includeClosed} />;
  if (failed) return <section className="open-pull-requests" aria-label="Pull requests"><PullRequestListHeader includeClosed={includeClosed} />
    <div className="empty-state pull-request-empty"><button onClick={() => { setFailed(false); setAttempt((current) => current + 1); }}>Retry loading pull requests</button></div>
  </section>;
  return <PullRequestLoadingSection includeClosed={includeClosed} />;
}
