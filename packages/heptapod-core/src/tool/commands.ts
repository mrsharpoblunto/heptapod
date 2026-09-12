import { captureNarrative } from "./capture.js";
import { resolveReviewNarrativePath, resolveReviewRunDirectory } from "./cache.js";
import { ingestNarrative } from "./ingest.js";
import { loadManifest } from "./manifest.js";
import { resolvePullRequest, resolveRevisionRange, type ReviewSourceSelection } from "./review-source.js";
import { verifyNarrative } from "./verify.js";

export interface SourceSelector { pr?: string; rev?: string }
export function selectReviewSource(repo: string, selection: SourceSelector) {
  if (Boolean(selection.pr) === Boolean(selection.rev)) throw new Error("Choose exactly one of --pr or --rev.");
  return selection.pr ? resolvePullRequest(repo, selection.pr) : resolveRevisionRange(repo, selection.rev!);
}
export function captureReview(repo: string, selection: SourceSelector, outputDirectory?: string) {
  return captureReviewSource(repo, selectReviewSource(repo, selection), outputDirectory);
}
export function captureReviewSource(repo: string, source: ReviewSourceSelection, outputDirectory?: string) {
  return captureNarrative(repo, source.base, source.head, outputDirectory ?? resolveReviewRunDirectory(source.id), { githubPrUrl: source.githubPrUrl, title: source.title });
}
export function validateReview(repo: string, id: string, narrativePath = resolveReviewNarrativePath(id)) {
  const { manifest, manifestPath } = loadManifest(narrativePath, repo);
  return { id, narrative: manifestPath, ...verifyNarrative(repo, manifest, manifestPath) };
}
interface IngestOptions { narrativePath?: string; siteUrl?: string; onProgress?: (message: string) => void }
export function ingestReview(repo: string, selection: SourceSelector, options: IngestOptions = {}) {
  return ingestReviewSource(repo, selectReviewSource(repo, selection), options);
}
export function ingestReviewSource(repo: string, source: ReviewSourceSelection, options: IngestOptions = {}) {
  const narrativePath = options.narrativePath ?? resolveReviewNarrativePath(source.id);
  const { manifest } = loadManifest(narrativePath, repo);
  if (manifest.source.base !== source.base || manifest.source.head !== source.head
    || (source.githubPrUrl && manifest.source.github?.pullRequestUrl !== source.githubPrUrl)) throw new Error(`Cached narrative ${source.id} does not match the selected source revisions or pull request; capture and author it again.`);
  return ingestNarrative({ id: source.id, repo, narrativePath, siteUrl: options.siteUrl, collectRemoteEvidence: true, onTestProgress: options.onProgress });
}
