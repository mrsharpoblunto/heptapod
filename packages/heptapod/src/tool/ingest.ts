import {
  beginReviewIngestion,
  failReviewIngestion,
  updateReviewIngestion,
  upsertReview,
  type ReadyStoredReview,
} from "./database.js";
import { collectGitHubEvidence } from "./github.js";
import { loadManifest } from "./manifest.js";
import { buildReviewModel } from "./model.js";
import { analyzeNarrative } from "./test-analysis.js";
import { executeNarrativeTests } from "./test-execution.js";
import { buildReviewUrl } from "./url.js";
import { verifyNarrative } from "./verify.js";

export interface IngestedReview extends ReadyStoredReview {
  url: string;
}

export function ingestNarrative({
  id,
  repo,
  narrativePath,
  databasePath,
  siteUrl,
  collectRemoteEvidence = false,
  onTestProgress,
}: {
  id: string;
  repo: string;
  narrativePath: string;
  databasePath?: string;
  siteUrl?: string;
  collectRemoteEvidence?: boolean;
  onTestProgress?: (message: string) => void;
}): IngestedReview {
  const { manifest, manifestPath } = loadManifest(narrativePath);
  beginReviewIngestion(id, {
    title: manifest.title,
    summary: manifest.summary,
    sourceUrl: manifest.source.github?.pullRequestUrl,
    baseRevision: manifest.source.base,
    headRevision: manifest.source.head,
  }, databasePath);
  const progress = (message: string) => {
    updateReviewIngestion(id, message, databasePath);
    onTestProgress?.(message);
  };
  try {
    progress("Validating the exact narrative patch stack");
    const verification = verifyNarrative(repo, manifest, manifestPath);
    progress("Analyzing changed files and test cases");
    const analysis = analyzeNarrative(repo, manifest, manifestPath);
    const testExecution = executeNarrativeTests(repo, manifest, manifestPath, progress, analysis.testAreasByStep);
    progress("Collecting pull-request evidence");
    const manualEvidence = collectRemoteEvidence ? collectGitHubEvidence(manifest.source.github) : [];
    progress("Building the review payload");
    const model = buildReviewModel(
      manifest,
      manifestPath,
      verification,
      analysis.testAreasByStep,
      analysis.filesByStep,
      analysis.referenceFilesByStep,
      manualEvidence,
      testExecution,
    );
    const review = upsertReview(id, model, databasePath);
    return { ...review, url: buildReviewUrl(id, siteUrl) };
  } catch (error) {
    failReviewIngestion(id, error instanceof Error ? error.message : String(error), databasePath);
    throw error;
  }
}
