# @thestraylight/heptapod-core

Shared APIs for capturing immutable Git comparisons, validating narrative metadata, running ingestion, storing reviews, and preparing reviews with Codex or Claude Code. The CLI and API sidecar both invoke this package.

`captureReview(repo, { pr | rev })` writes the metadata scaffold and a `preparing` database entry. Its result includes the review ID, absolute `metadataDirectory`, and `narrative` path. `validateReview(repo, id)` verifies the patch stack. `ingestReview(repo, { pr | rev })` checks the selected revisions and ingests the authored narrative.

Ingestion also precomputes Difftastic structural diffs for the narrative step snapshots. `PatchFile.semanticDiff` contains validated alignment and UTF-16 token ranges, or a per-file fallback reason; absent fields on older payloads use standard diffs. Successful results are cached by source contents and Difftastic version. Configure `diff.engine`, `diff.executable`, and `diff.timeoutMs` in `.heptapod.json`. Generation uses `difft` installed on the host (or a configured `diff.executable`), with a 10-second per-file timeout. The homepage checklist reports host availability. Difftastic is optional; no binary is packaged or downloaded. Missing tools and failed diffs do not fail ingestion. `RenderModel.diffGeneration` records the version and success/fallback counts.

`prepareReview(repo, prNumber, agentId)` captures a GitHub PR, launches an installed and authenticated agent with its Heptapod skill, independently validates the authored metadata, and ingests it. Preparation remains `preparing` until ingestion begins; ingestion uses `pending`, followed by `ready` or `failed`.

Capture and ingestion include synchronous Git/SQLite/test operations. Server applications should invoke them in workers, as the API sidecar does, to keep request handling responsive.
