# @thestraylight/heptapod-api

Local HTTP sidecar for Heptapod. The web launcher starts it automatically on `127.0.0.1` at the web port plus one, waits for readiness, and stops it with the web server. In development, the launcher builds the core and API packages before starting them. Restart development after changing core/API source.

The browser accesses the sidecar through the web server's `/api/service/*` proxy. Long operations return HTTP 202 and run in separate job processes; Git operations and ingestion cannot block polling. Both harnesses use `@thestraylight/heptapod-core` and the same repository-local SQLite database.

| Request | Result |
| --- | --- |
| `GET /health` | Readiness |
| `GET /reviews?review=<id>` | Persisted review status and progress; omit `review` to list statuses |
| `POST /reviews/prepare` with `{ "number": 42, "agent": "codex" }` | Capture, agent authoring, validation, and ingestion job |
| `POST /reviews/capture` or `/reviews/ingest` with `{ "pr": "42" }` or `{ "rev": "base...head" }` | Shared core command job |
| `POST /reviews/<id>/refresh` | Recapture latest PR with the original agent, falling back to the configured default for legacy imports |
| `GET /jobs/<job-id>` | Job status, result, or error |
| `DELETE /reviews?review=<id>` | Cancel all associated jobs and subprocesses, then delete the review and its metadata |
| `GET/PUT /reviews/<id>/draft` | Read/save a review draft |
| `POST /reviews/<id>/draft/publish` with `{ "version": 1 }` | Background GitHub draft publication job |

Mutations require the web origin in the `Origin` header. Job results are retained in memory for one hour; review status, metadata paths, and draft publication progress persist in SQLite. An interrupted publication can be retried without duplicating already published comments.

For standalone operation, build the packages and set `HEPTAPOD_ROOT`, `HEPTAPOD_API_PORT` (default 3001), and `HEPTAPOD_WEB_ORIGIN` (default `http://localhost:3000`) before running `heptapod-api`.

Deleting an active review waits for its process tree to stop before removing the database entry and metadata. Cancelled jobs report `cancelled`; jobs still resolving their review ID cannot recreate a review deleted after they started.

Agent identity persists with the review. Refresh keeps the previous payload readable, archives the prior metadata under the review’s `history/` folder, and regenerates metadata from the latest PR commits before ingestion.
