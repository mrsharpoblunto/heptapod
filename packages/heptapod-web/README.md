# @thestraylight/heptapod-web

The packaged Next.js site for viewing reviews ingested by the Heptapod CLI. Install it alongside `@thestraylight/heptapod` in the repository being reviewed.

```sh
pnpm exec heptapod-web --port 3000
```

Run it from inside the target Git repository. The site and CLI automatically share `node_modules/.cache/heptapod/reviews.sqlite` beneath that repository root.

For a locally linked development checkout, use `pnpm exec heptapod-web-dev --port 3000`. It runs the linked Next.js source with hot reload; `heptapod-web` serves the last production build.

The launcher starts the API sidecar on the web port plus one (3001 in this example). Preparation, ingestion, and GitHub draft publication return background jobs, and the browser polls `/api/service/` for updates. Development builds core/API on startup; restart after changing their source.

The homepage streams a setup checklist and imported reviews, then loads open PRs with agent preparation controls. The root layout starts the checklist checks as RSC promises and shares them through context, preserving their resolved results across navigation without a separate store. Capture immediately displays **Preparing review** while the agent authors and validates metadata.

Pull request discovery uses cursor pagination: the initial page and infinite scroll request pages directly from the Next.js `/api/pull-requests` route. Each response includes diff totals, base/head commit hashes, and the next cursor. These short requests do not create sidecar jobs.

GitHub avatar and status requests start as RSC promises. Their results populate a reducer store in the root layout, retaining cached metadata across navigation while refreshed values resolve.

The initial review list renders through RSC. Subsequent homepage updates poll JSON card summaries from Next.js `/api/reviews` and update client state directly, without RSC refreshes. This short database read ships with its matching UI; long operations still run in the sidecar. Import, refresh, and delete actions invalidate that same JSON list. New cards load missing GitHub identity into the shared cache once.

Refresh compares the current PR base/head commits with the imported review. An unchanged comparison reuses its metadata and runs ingestion/tests directly, without capturing again or launching an agent. Changed comparisons or missing metadata use the original import agent, falling back to the configured default for older reviews without agent provenance.
