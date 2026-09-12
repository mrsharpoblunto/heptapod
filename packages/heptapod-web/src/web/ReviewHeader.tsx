"use client";

import { ChevronLeft, LoaderCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  GitHubIcon,
  PullRequestAvatar,
  PullRequestBadges,
  useGitHubPullRequestMetadata,
} from "./GitHubIdentity";

export interface ReviewHeaderData {
  id: string;
  title: string;
  summary: string;
  sourceUrl: string | null;
  baseRevision: string;
  headRevision: string;
  updatedAt: string;
  additions: number | null;
  deletions: number | null;
}

export function reviewPath(id: string): string {
  return `/reviews/${id.split("/").map(encodeURIComponent).join("/")}`;
}

function githubSource(sourceUrl: string | null): { repositoryUrl: string; number: string } | null {
  const match = sourceUrl?.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
  return match ? { repositoryUrl: match[1], number: match[2] } : null;
}

function formattedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function ReviewSourceMetadata({ review, updating }: { review: ReviewHeaderData; updating: boolean }): ReactNode {
  const github = githubSource(review.sourceUrl);
  const revision = (commit: string) => github ? (
    <a href={`${github.repositoryUrl}/commit/${commit}`} target="_blank" rel="noreferrer">
      <code>{commit.slice(0, 7)}</code>
    </a>
  ) : <code>{commit.slice(0, 7)}</code>;

  return <div className="source-metadata">
    {updating && <span className="review-updating" role="status">
      <LoaderCircle aria-hidden="true" className="progress-spinner" size={14} />
      <span>Updating…</span>
    </span>}
    {review.sourceUrl && github && <a className="github-link" href={review.sourceUrl} target="_blank" rel="noreferrer">
      <GitHubIcon />
      <span>PR #{github.number}</span>
    </a>}
    <div className="revisions">
      {revision(review.baseRevision)}
      <span aria-hidden="true">→</span>
      {revision(review.headRevision)}
    </div>
    {review.additions !== null && review.deletions !== null && <div className="source-diff-stats">
      <span className="additions">+{review.additions}</span>
      <span className="deletions">−{review.deletions}</span>
    </div>}
    <time className="review-date" dateTime={review.updatedAt}>{formattedDate(review.updatedAt)}</time>
  </div>;
}

export function ReviewHeader({
  review,
  compact = false,
  updating = false,
  children,
}: {
  review: ReviewHeaderData;
  compact?: boolean;
  updating?: boolean;
  children?: ReactNode;
}): ReactNode {
  const githubMetadata = useGitHubPullRequestMetadata(review.id, Boolean(review.sourceUrl));
  const title = compact
    ? <h2>{review.title}</h2>
    : <strong className="review-title">{review.title}</strong>;

  const heading = <div className={`review-heading${compact ? " review-heading-compact" : ""}`}>
    {!compact && <Link className="review-back-link" href="/" aria-label="Back to reviews" title="Back to reviews">
      <ChevronLeft aria-hidden="true" size={20} />
    </Link>}
    {review.sourceUrl && <PullRequestAvatar metadata={githubMetadata} compact={compact} />}
    <div className="title-block">
      <div className="title-line">
        {title}
        {review.sourceUrl && <PullRequestBadges metadata={githubMetadata} />}
      </div>
      <span className="review-subheader">{review.summary}</span>
      {compact && <ReviewSourceMetadata review={review} updating={updating} />}
      {children}
    </div>
  </div>;

  return <>
    {heading}
    {!compact && <ReviewSourceMetadata review={review} updating={updating} />}
  </>;
}
