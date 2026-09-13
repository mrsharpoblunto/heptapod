export type StepKind = "description" | "tests" | "refactor" | "implementation" | "manual";
export type CheckStatus = "passing" | "failing" | "not-run" | "blocked" | "not-applicable";
export type CheckBasis = "observed" | "expected";

export interface Check {
  label: string;
  status: CheckStatus;
  basis: CheckBasis;
  command?: string;
  detail?: string;
  evidence?: Evidence[];
}

export interface StepChecks {
  automated: Check[];
  manual: Check[];
}

export interface TestCase {
  name: string;
  description: string;
  change?: string;
  files: string[];
}

export type TestCaseChangeKind = "added" | "removed" | "changed" | "moved";

export interface ParsedTestCaseChange {
  name: string;
  change: TestCaseChangeKind;
  oldLine?: number;
  oldEndLine?: number;
  newLine?: number;
  newEndLine?: number;
}

export interface TestFileChange {
  path: string;
  isFixture?: boolean;
  cases: ParsedTestCaseChange[];
}

export interface TestAreaChange {
  name: string;
  description: string;
  files: TestFileChange[];
}

export interface FileSnapshot {
  beforeContent: string | null;
  afterContent: string | null;
}

export interface Evidence {
  url: string;
  label: string;
  kind: "image" | "video" | "link";
  sourceUrl?: string;
}

export interface InterfaceChange {
  name: string;
  description?: string;
  file?: string;
  before?: string;
  after?: string;
  callsites: Callsite[];
}

export interface Callsite {
  label: string;
  file: string;
  change?: TestCaseChangeKind;
}

export interface ImplementationSection {
  name: string;
  priority: "critical" | "secondary";
  description: string;
  files: Callsite[];
}

export interface NarrativeStep {
  id: string;
  title: string;
  kind: StepKind;
  body?: string;
  diff?: string;
  checks: StepChecks;
  cases?: TestCase[];
  interfaces?: InterfaceChange[];
  sections?: ImplementationSection[];
  evidence?: Evidence[];
}

export interface ChangedFile {
  status: string;
  path: string;
  from?: string;
}

export interface GitHubSource {
  pullRequestUrl: string;
  repositoryUrl: string;
  number: number;
}

export interface GitHubPullRequestMetadata {
  login: string;
  avatarUrl: string;
  profileUrl: string;
  state: "open" | "draft" | "merged" | "closed";
}

export interface NarrativeManifest {
  schemaVersion: 1;
  title: string;
  summary: string;
  source: {
    base: string;
    head: string;
    diff: string;
    files?: ChangedFile[];
    github?: GitHubSource;
  };
  steps: NarrativeStep[];
}

export interface VerificationResult {
  base: string;
  head: string;
  tree: string;
  sourceBytes: number;
  patchSteps: number;
  exact: true;
  /** Snapshot of the Git attribute exclusions used to validate and render this review. */
  generatedFiles?: string[];
}

export type ObservedTestStatus = "passing" | "failing" | "timed-out" | "not-run";
export type ExpectedTestStatus = "passing" | "failing" | "not-specified";

export interface StepTestRun {
  command: string | null;
  scope: "changed-tests" | "full-suite";
  files: string[];
  status: ObservedTestStatus;
  expectedStatus: ExpectedTestStatus;
  expectationMatched: boolean | null;
  exitCode: number | null;
  durationMs: number;
  expectedFailures: string[];
  observedFailures: string[];
  unexpectedFailures: string[];
  fixtureRuns: TestFixtureRun[];
  output: string;
  detail?: string;
}

export interface TestFixtureRun {
  file: string;
  command: string;
  status: ObservedTestStatus;
  expectedStatus: ExpectedTestStatus;
  expectationMatched: boolean | null;
  exitCode: number | null;
  durationMs: number;
  observedFailures: string[];
  unexpectedFailures: string[];
  output: string;
  detail?: string;
}

export interface TestExecutionMetadata {
  command: string | null;
  worktreeBase: string;
  timeoutMs: number;
  dependencySource?: string;
}

export interface PatchFile {
  path: string;
  from?: string;
  patch: string;
  beforeContent?: string | null;
  afterContent?: string | null;
}

export interface PatchStats {
  additions: number;
  deletions: number;
  files: number;
}

export interface RenderStep extends NarrativeStep {
  number: number;
  body: string;
  patch: string;
  fileDiffs: PatchFile[];
  referenceFiles?: PatchFile[];
  stats: PatchStats;
  testAreas?: TestAreaChange[];
  testRun?: StepTestRun;
}

export interface RenderModel {
  title: string;
  summary: string;
  source: NarrativeManifest["source"] & { stats: PatchStats };
  verification: VerificationResult;
  testExecution?: TestExecutionMetadata;
  steps: RenderStep[];
}

export type ReviewCommentTarget =
  | { kind: "section"; stepId: string; anchor: string; section: string }
  | { kind: "quote"; stepId: string; anchor: string; section: string; quote: string; start: number; end: number }
  | { kind: "file"; stepId: string; anchor: string; path: string }
  | { kind: "line"; stepId: string; anchor: string; path: string; side: "LEFT" | "RIGHT"; startLine: number; endLine: number };

export interface ReviewComment {
  id: string;
  body: string;
  target: ReviewCommentTarget;
}

export interface ReviewDraft {
  id: string;
  reviewId: string;
  head: string;
  version: number;
  summary: string;
  summaryIsCombined?: boolean;
  comments: ReviewComment[];
  githubReviewId: string | null;
  githubUrl: string | null;
  publishedAt: string | null;
  publishing: boolean;
}

export interface ReviewThreadPreview {
  commentId: string;
  body: string;
  path: string;
  subjectType: "FILE" | "LINE";
  side?: "LEFT" | "RIGHT";
  line?: number;
  startLine?: number;
  snippet: string;
  error?: string;
}

export interface ReviewDraftPreview {
  body: string;
  threads: ReviewThreadPreview[];
  errors: string[];
}
