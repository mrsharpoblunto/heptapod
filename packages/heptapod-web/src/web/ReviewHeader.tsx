"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import type { GitHubPullRequestMetadata } from "@thestraylight/heptapod-core/types";
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

function ReviewSourceMetadata({ review }: { review: ReviewHeaderData }): ReactNode {
  const github = githubSource(review.sourceUrl);
  const revision = (commit: string) => github ? (
    <a href={`${github.repositoryUrl}/commit/${commit}`} target="_blank" rel="noreferrer">
      <code>{commit.slice(0, 7)}</code>
    </a>
  ) : <code>{commit.slice(0, 7)}</code>;

  return <div className="source-metadata">
    {review.sourceUrl && github && <a className="github-link" href={review.sourceUrl} target="_blank" rel="noreferrer">
      <GitHubIcon />
      <span>PR #{github.number}</span>
    </a>}
    {review.baseRevision && review.headRevision && <div className="revisions">
      {revision(review.baseRevision)}
      <span aria-hidden="true">→</span>
      {revision(review.headRevision)}
    </div>}
    {review.additions !== null && review.deletions !== null && <div className="source-diff-stats">
      <span className="additions">+{review.additions}</span>
      <span className="deletions">−{review.deletions}</span>
    </div>}
    <time className="review-date" dateTime={review.updatedAt}>{formattedDate(review.updatedAt)}</time>
  </div>;
}

function Avatar({ id, compact }: { id: string; compact: boolean }) {
  return <PullRequestAvatar metadata={useGitHubPullRequestMetadata(id)} compact={compact} />;
}
function Badges({ id }: { id: string }) {
  return <PullRequestBadges metadata={useGitHubPullRequestMetadata(id)} />;
}

export function ReviewHeader({
  review,
  compact = false,
  children,
  metadata,
  actions,
  cardActions,
}: {
  review: ReviewHeaderData;
  compact?: boolean;
  children?: ReactNode;
  metadata?: GitHubPullRequestMetadata;
  actions?: ReactNode;
  cardActions?: ReactNode;
}): ReactNode {
  const title = compact
    ? <h2>{review.title}</h2>
    : <strong className="review-title">{review.title}</strong>;

  const heading = <div className={`review-heading${compact ? " review-heading-compact" : ""}`}>
    {!compact && <Link className="review-back-link" href="/" aria-label="Back to reviews" title="Back to reviews">
      <ChevronLeft aria-hidden="true" size={20} />
    </Link>}
    {review.sourceUrl && <Suspense fallback={<PullRequestAvatar metadata={undefined} compact={compact} />}>{metadata ? <PullRequestAvatar metadata={metadata} compact={compact} /> : <Avatar id={review.id} compact={compact} />}</Suspense>}
    <div className={`title-block${actions ? " title-block-with-actions" : ""}`}>
      <div className="title-line">
        {review.sourceUrl && <Suspense fallback={<PullRequestBadges metadata={undefined} />}>{metadata ? <PullRequestBadges metadata={metadata} /> : <Badges id={review.id} />}</Suspense>}
        {title}
      </div>
      {actions && <div className="review-heading-actions">{actions}</div>}
      {!cardActions && review.summary && <span className="review-subheader">{review.summary}</span>}
      {!cardActions && compact && <ReviewSourceMetadata review={review} />}
      {!cardActions && children}
    </div>
  </div>;

  if (cardActions) return <>
    <div className="review-card-header">{heading}</div>
    <div className="review-card-body">
      <div className="review-card-details">
        {review.summary && <span className="review-subheader">{review.summary}</span>}
        <ReviewSourceMetadata review={review} />
        {children}
      </div>
      {cardActions}
    </div>
  </>;

  return <>
    {heading}
    {!compact && <ReviewSourceMetadata review={review} />}
  </>;
}
