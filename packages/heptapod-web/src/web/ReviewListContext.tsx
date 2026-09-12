"use client";

import { createContext, useContext } from "react";
import type { ReviewSummary } from "./ReviewCard";

export const ReviewListContext = createContext<{ reviews: ReviewSummary[]; refresh: () => void } | null>(null);
export function useReviewList() { return useContext(ReviewListContext); }
