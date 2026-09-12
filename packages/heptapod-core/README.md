# @thestraylight/heptapod-core

Shared APIs for capturing immutable Git comparisons, validating narrative metadata, running ingestion, storing reviews, and preparing reviews with Codex or Claude Code. The CLI and API sidecar both invoke this package.

`captureReview(repo, { pr | rev })` writes the metadata scaffold and a `preparing` database entry. Its result includes the review ID, absolute `metadataDirectory`, and `narrative` path. `validateReview(repo, id)` verifies the patch stack. `ingestReview(repo, { pr | rev })` checks the selected revisions and ingests the authored narrative.

`prepareReview(repo, prNumber, agentId)` captures a GitHub PR, launches an installed and authenticated agent with its Heptapod skill, independently validates the authored metadata, and ingests it. Preparation remains `preparing` until ingestion begins; ingestion uses `pending`, followed by `ready` or `failed`.

Capture and ingestion include synchronous Git/SQLite/test operations. Server applications should invoke them in workers, as the API sidecar does, to keep request handling responsive.
