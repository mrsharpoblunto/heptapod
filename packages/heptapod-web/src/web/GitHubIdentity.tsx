"use client";

import { createContext, use, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { GitHubPullRequestMetadata } from "@thestraylight/heptapod-core/types";

export type GitHubMetadataPromises = Record<string, Promise<GitHubPullRequestMetadata | null>>;
type MetadataEntry = { promise: Promise<GitHubPullRequestMetadata | null>; metadata?: GitHubPullRequestMetadata | null };
type MetadataCache = Record<string, MetadataEntry>;
type MetadataAction =
  | { type: "request"; reviewId: string; promise: MetadataEntry["promise"] }
  | { type: "resolve"; reviewId: string; promise: MetadataEntry["promise"]; metadata: GitHubPullRequestMetadata | null };

export function metadataCacheReducer(state: MetadataCache, action: MetadataAction): MetadataCache {
  const current = state[action.reviewId];
  if (action.type === "request") {
    if (current?.promise === action.promise) return state;
    return { ...state, [action.reviewId]: { ...current, promise: action.promise } };
  }
  if (current?.promise !== action.promise) return state;
  return { ...state, [action.reviewId]: { ...current, metadata: action.metadata } };
}

const GitHubMetadataContext = createContext<GitHubMetadataPromises>({});
const GitHubMetadataStoreContext = createContext<{
  cache: MetadataCache; dispatch: (action: MetadataAction) => void; load: (reviewId: string) => void;
} | null>(null);

// The root layout owns the cache so navigating between the list and a review retains it.
export function GitHubMetadataStoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [cache, dispatch] = useReducer(metadataCacheReducer, {});
  const requests = useRef(new Map<string, MetadataEntry["promise"]>());
  const load = useCallback((reviewId: string) => {
    if (requests.current.has(reviewId)) return;
    const promise = fetch(`/api/reviews/${encodeURIComponent(reviewId)}/github-metadata`).then(async (response) => {
      if (!response.ok) return null;
      const result = await response.json() as { metadata: GitHubPullRequestMetadata | null };
      return result.metadata;
    }).catch(() => null);
    requests.current.set(reviewId, promise);
    dispatch({ type: "request", reviewId, promise });
    void promise.then((metadata) => dispatch({ type: "resolve", reviewId, promise, metadata }));
  }, []);
  const value = useMemo(() => ({ cache, dispatch, load }), [cache, load]);
  return <GitHubMetadataStoreContext.Provider value={value}>{children}</GitHubMetadataStoreContext.Provider>;
}

// Page renders start these promises on the server. Their results hydrate the persistent store.
export function GitHubMetadataProvider({ children, promises }: { children: ReactNode; promises: GitHubMetadataPromises }): ReactNode {
  const store = useContext(GitHubMetadataStoreContext);
  const dispatch = store?.dispatch;
  useEffect(() => {
    if (!dispatch) return;
    let active = true;
    for (const [reviewId, promise] of Object.entries(promises)) {
      dispatch({ type: "request", reviewId, promise });
      void promise.then((metadata) => {
        if (active) dispatch({ type: "resolve", reviewId, promise, metadata });
      }, () => {
        if (active) dispatch({ type: "resolve", reviewId, promise, metadata: null });
      });
    }
    return () => { active = false; };
  }, [dispatch, promises]);
  return <GitHubMetadataContext.Provider value={promises}>{children}</GitHubMetadataContext.Provider>;
}

export function GitHubIcon({ size = 16 }: { size?: number }): ReactNode {
  return <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path fill="currentColor" d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.51-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.97-.82-1.17-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.21-3.64-.91-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.2-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.5 7.5 0 0 1 8 3.89c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.96.08 2.16.51.57.82 1.3.82 2.19 0 3.12-1.87 3.81-3.65 4.02.29.25.54.74.54 1.51 0 1.09-.01 1.97-.01 2.25 0 .22.15.47.55.39A8.03 8.03 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z" />
  </svg>;
}

// Non-suspending consumers can wait for the same server-fed store without blocking the viewer.
export function useCachedGitHubPullRequestMetadata(reviewId?: string) {
  const store = useContext(GitHubMetadataStoreContext);
  return reviewId ? store?.cache[reviewId]?.metadata : undefined;
}

export function useGitHubPullRequestMetadata(reviewId?: string, enabled = true) {
  const promises = useContext(GitHubMetadataContext);
  const store = useContext(GitHubMetadataStoreContext);
  const entry = reviewId ? store?.cache[reviewId] : undefined;
  const serverPromise = reviewId ? promises[reviewId] : undefined;
  const load = store?.load;
  useEffect(() => {
    // Imports discovered by JSON polling have no initial RSC metadata promise.
    if (enabled && reviewId && !entry && !serverPromise) load?.(reviewId);
  }, [enabled, reviewId, entry, serverPromise, load]);
  if (!enabled || !reviewId) return null;
  const cached = entry?.metadata;
  if (cached !== undefined) return cached;
  const promise = serverPromise ?? entry?.promise;
  return promise ? use(promise) : undefined;
}

export function PullRequestAvatar({
  metadata,
  compact = false,
}: {
  metadata: GitHubPullRequestMetadata | null | undefined;
  compact?: boolean;
}): ReactNode {
  const className = `author-avatar${compact ? " author-avatar-compact" : ""}`;
  if (metadata === undefined) return <span className={`${className} avatar-shimmer shimmer`} aria-label="Loading pull request author" />;
  if (metadata === null) return null;
  return <a className={className} href={metadata.profileUrl} target="_blank" rel="noreferrer" title={`@${metadata.login}`}>
    <img src={metadata.avatarUrl} alt={`@${metadata.login}`} />
  </a>;
}

export function PullRequestBadges({
  metadata,
}: {
  metadata: GitHubPullRequestMetadata | null | undefined;
}): ReactNode {
  if (metadata === undefined) return <span className="identity-copy" aria-label="Loading pull request status">
    <span className="state-badge-shimmer shimmer" />
  </span>;
  if (metadata === null) return null;
  const label = metadata.state[0].toUpperCase() + metadata.state.slice(1);
  return <span className="identity-copy">
    <span className={`pr-state pr-state-${metadata.state}`}>{label}</span>
  </span>;
}
