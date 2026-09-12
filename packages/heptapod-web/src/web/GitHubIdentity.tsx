"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { GitHubPullRequestMetadata } from "@thestraylight/heptapod/types";

interface MetadataCacheEntry {
  status: "loading" | "loaded";
  metadata: GitHubPullRequestMetadata | null;
}

type MetadataCache = Record<string, MetadataCacheEntry>;

type MetadataCacheAction =
  | { type: "request"; reviewId: string }
  | { type: "resolve"; reviewId: string; metadata: GitHubPullRequestMetadata | null };

interface GitHubMetadataContextValue {
  cache: MetadataCache;
  load: (reviewId: string) => void;
}

const GitHubMetadataContext = createContext<GitHubMetadataContextValue | null>(null);

function metadataCacheReducer(state: MetadataCache, action: MetadataCacheAction): MetadataCache {
  if (action.type === "request") {
    if (state[action.reviewId]) return state;
    return { ...state, [action.reviewId]: { status: "loading", metadata: null } };
  }
  return {
    ...state,
    [action.reviewId]: { status: "loaded", metadata: action.metadata },
  };
}

async function fetchGitHubMetadata(
  reviewId: string,
  signal?: AbortSignal,
): Promise<GitHubPullRequestMetadata | null> {
  const response = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}/github-metadata`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) return null;
  const result = await response.json() as { metadata?: GitHubPullRequestMetadata | null };
  return result.metadata ?? null;
}

export function GitHubMetadataProvider({ children }: { children: ReactNode }): ReactNode {
  const [cache, dispatch] = useReducer(metadataCacheReducer, {});
  const requests = useRef(new Map<string, AbortController>());

  const load = useCallback((reviewId: string) => {
    if (cache[reviewId] || requests.current.has(reviewId)) return;
    const controller = new AbortController();
    requests.current.set(reviewId, controller);
    dispatch({ type: "request", reviewId });
    void fetchGitHubMetadata(reviewId, controller.signal)
      .then((metadata) => dispatch({ type: "resolve", reviewId, metadata }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          dispatch({ type: "resolve", reviewId, metadata: null });
        }
      })
      .finally(() => requests.current.delete(reviewId));
  }, [cache]);

  useEffect(() => {
    const activeRequests = requests.current;
    return () => {
      for (const controller of activeRequests.values()) controller.abort();
      activeRequests.clear();
    };
  }, []);

  const value = useMemo(() => ({ cache, load }), [cache, load]);
  return <GitHubMetadataContext.Provider value={value}>{children}</GitHubMetadataContext.Provider>;
}

export function GitHubIcon({ size = 16 }: { size?: number }): ReactNode {
  return <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path fill="currentColor" d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.51-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.97-.82-1.17-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.21-3.64-.91-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.2-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.5 7.5 0 0 1 8 3.89c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.96.08 2.16.51.57.82 1.3.82 2.19 0 3.12-1.87 3.81-3.65 4.02.29.25.54.74.54 1.51 0 1.09-.01 1.97-.01 2.25 0 .22.15.47.55.39A8.03 8.03 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z" />
  </svg>;
}

export function useGitHubPullRequestMetadata(reviewId?: string, enabled = true) {
  const context = useContext(GitHubMetadataContext);
  const [standaloneMetadata, setStandaloneMetadata] = useState<GitHubPullRequestMetadata | null | undefined>(
    enabled && reviewId ? undefined : null,
  );

  useEffect(() => {
    if (!enabled || !reviewId) {
      setStandaloneMetadata(null);
      return;
    }
    if (context) {
      context.load(reviewId);
      return;
    }
    const controller = new AbortController();
    void fetchGitHubMetadata(reviewId, controller.signal)
      .then(setStandaloneMetadata)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setStandaloneMetadata(null);
      });
    return () => controller.abort();
  }, [context, enabled, reviewId]);

  if (!enabled || !reviewId) return null;
  if (!context) return standaloneMetadata;
  const entry = context.cache[reviewId];
  return entry?.status === "loaded" ? entry.metadata : undefined;
}

export function PullRequestAvatar({
  metadata,
  compact = false,
}: {
  metadata: GitHubPullRequestMetadata | null | undefined;
  compact?: boolean;
}): ReactNode {
  if (metadata === undefined) return <span className={`${compact ? "avatar-shimmer-compact" : "avatar-shimmer"} shimmer`} aria-label="Loading pull request author" />;
  if (metadata === null) return null;
  return <a className={`author-avatar${compact ? " author-avatar-compact" : ""}`} href={metadata.profileUrl} target="_blank" rel="noreferrer" title={`View @${metadata.login} on GitHub`}>
    <img src={metadata.avatarUrl} alt={`@${metadata.login}`} />
  </a>;
}

export function PullRequestBadges({
  metadata,
}: {
  metadata: GitHubPullRequestMetadata | null | undefined;
}): ReactNode {
  if (metadata === undefined) return <span className="identity-copy" aria-label="Loading pull request status">
    <span className="identity-badge-shimmer shimmer" />
    <span className="state-badge-shimmer shimmer" />
  </span>;
  if (metadata === null) return null;
  const label = metadata.state[0].toUpperCase() + metadata.state.slice(1);
  return <span className="identity-copy">
    <a className="author-badge" href={metadata.profileUrl} target="_blank" rel="noreferrer">@{metadata.login}</a>
    <span className={`pr-state pr-state-${metadata.state}`}>{label}</span>
  </span>;
}
