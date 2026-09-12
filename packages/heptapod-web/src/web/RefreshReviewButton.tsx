"use client";

import { agentDefinitions } from "./agent-definitions";
import { useReviewList } from "./ReviewListContext";

import { useToast } from "./Toasts";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentId } from "@thestraylight/heptapod-core/agents";

export function RefreshReviewButton({ id, agentId, disabled }: { id: string; agentId?: AgentId | null; disabled: boolean }) {
  const router = useRouter();
  const list = useReviewList();
  const [starting, setStarting] = useState(false);
  const notify = useToast();
  const refresh = async () => {
    setStarting(true);
    try {
      const response = await fetch(`/api/service/reviews/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "Could not refresh this review.");
      }
      if (list) list.refresh();
      else router.refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setStarting(false); }
  };
  return <>
    <button className="review-refresh" aria-label={`Refresh review ${id}`} disabled={disabled || starting}
      title={`${!agentId ? "Refresh with the default agent" : `Refresh with ${agentDefinitions[agentId].displayName}`}. If the PR is unchanged, reuse the metadata and rerun tests.`}
      onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" className={starting ? "progress-spinner" : undefined} /></button>
  </>;
}
