"use client";

import { createContext, useContext, type ReactNode } from "react";

const RepositoryContext = createContext<string | null>(null);

export function RepositoryProvider({ id, children }: { id: string; children: ReactNode }) {
  return <RepositoryContext.Provider value={id}>{children}</RepositoryContext.Provider>;
}

export function useRepositoryId(): string | null {
  return useContext(RepositoryContext);
}

export function repositoryServicePath(repositoryId: string | null, path: string): string {
  return repositoryId
    ? `/api/service/repositories/${encodeURIComponent(repositoryId)}${path}`
    : `/api/service${path}`;
}

export function repositoryReviewPath(repositoryId: string | null, reviewId: string): string {
  const review = reviewId.split("/").map(encodeURIComponent).join("/");
  return repositoryId ? `/repositories/${encodeURIComponent(repositoryId)}/reviews/${review}` : `/reviews/${review}`;
}
