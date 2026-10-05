# @thestraylight/heptapod-core

Shared APIs for capturing immutable Git comparisons, validating narrative metadata, running ingestion, storing reviews, and preparing reviews with Codex or Claude Code. The repository CLI performs the expensive repository work; the Next.js site uses the storage and review-draft APIs.

`captureReview(repo, { pr | rev })` writes the metadata scaffold and a `preparing` database entry. Its result includes the review ID, absolute `metadataDirectory`, and `narrative` path. `validateReview(repo, id)` verifies the patch stack. `ingestReview(repo, { pr | rev })` checks the selected revisions and ingests the authored narrative.

Ingestion also precomputes Difftastic structural diffs for the narrative step snapshots. `PatchFile.semanticDiff` contains validated alignment and UTF-16 token ranges, or a per-file fallback reason; absent fields on older payloads use standard diffs. Successful results are cached by source contents and Difftastic version. Configure `diff.engine`, `diff.executable`, and `diff.timeoutMs` in `.heptapod.json`. Generation uses `difft` installed on the host (or a configured `diff.executable`), with a 10-second per-file timeout. The homepage checklist reports host availability. Difftastic is optional; no binary is packaged or downloaded. Missing tools and failed diffs do not fail ingestion. `RenderModel.diffGeneration` records the version and success/fallback counts.

`prepareReview(repo, prNumber, agentId)` captures a GitHub PR, launches an installed agent with its Heptapod skill, asks that agent to run tests and perform local ingestion, then checks the source and evidence before returning the stored result. Unchanged comparisons also pass through the agent to refresh test evidence. Preparation remains `preparing` until ingestion begins; ingestion uses `pending`, followed by `ready` or `failed`.

Capture and ingestion include synchronous Git/SQLite operations and belong in the repository-local CLI, not a web request handler.

`ingestNarrative` loads mandatory `test-results.json` through `loadTestEvidence`; it never invokes project setup, builds, or tests. `verifyNarrative` returns per-step `stepTrees` for evidence binding. Evidence is agent-reported, checked for consistency, and stored with `testExecution.source: "agent"`.

`validateReview` also returns `testRequirements`, derived from metadata and reconstructed test declarations. Ingestion requires schema-version-2 evidence with exact target coverage and validates outcomes against attached Vitest/GoogleTest JSON reports (or process receipts for command-level checks only). Per-entry outcomes and expectation mismatches are retained in `StepTestRun.metadataResults`.
