"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { HeptapodBackdrop } from "./HeptapodBackdrop";

type ReviewBackdropState = "loading" | "ready";

const ReviewBackdropContext = createContext<(state: ReviewBackdropState) => void>(() => {});

export function PersistentBackdrop({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const [readyPath, setReadyPath] = useState<string | null>(null);
  const updateState = useCallback((state: ReviewBackdropState) => {
    setReadyPath(state === "ready" ? pathname : null);
  }, [pathname]);
  const isIndex = pathname === "/";
  const isReview = pathname.startsWith("/reviews/");
  const showBackdrop = isIndex || (isReview && readyPath !== pathname);

  return <ReviewBackdropContext.Provider value={updateState}>
    {showBackdrop && <HeptapodBackdrop />}
    {children}
  </ReviewBackdropContext.Provider>;
}

export function useReviewBackdropState(state: ReviewBackdropState): void {
  const updateState = useContext(ReviewBackdropContext);
  useEffect(() => updateState(state), [state, updateState]);
}
