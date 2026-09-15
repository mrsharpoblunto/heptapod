# @thestraylight/heptapod-web

The packaged persistent Next.js site for viewing reviews uploaded by repository-local Heptapod CLIs. It is installed once per machine through the main package.

```sh
pnpm add --global @thestraylight/heptapod
heptapod service install
```

The service defaults to port `49731`; `heptapod service configure --port <port>` stores a per-user override read by the site and every repository CLI.

For a locally linked development checkout, use `pnpm exec heptapod-web-dev --port 3000`. It runs the linked Next.js source with hot reload; `heptapod-web` serves the last production build.

Next serves the UI and control API on the same port; API routes live under `/api/service`. Repository CLIs use them to register repositories and upload versioned review results. There is no API sidecar. Development builds core on startup; restart after changing its source.

The homepage manages registered local repositories and streams an independent setup checklist for each one. Opening a repository lists its uploaded reviews. Capture, preparation, refresh, validation, tests, and ingestion remain repository-local and are not launched by the website.

GitHub avatar and status requests start as RSC promises. Their results populate a reducer store in the root layout, retaining cached metadata across navigation while refreshed values resolve.

Each repository review list renders through RSC and polls repository-scoped JSON summaries for newly uploaded results. The site can remove an imported review without deleting its repository-local narrative artifacts.

Difftastic is an optional host dependency shown in the homepage setup checklist. Install it to generate structural diffs during ingestion; otherwise reviews use standard diffs. No Difftastic binary is bundled or downloaded by Heptapod.

Agents can add optional `steps[].explanations` for complex or non-obvious changes. Each explanation targets a file and original/updated source line or range in that step's patch. Purple speech bubbles sit at the right edge of the corresponding diff row, distinct from blue reviewer comments; hover, focus, or tap to read the explanation and highlight its range. Both structural and standard diffs support these hints, including the details rail. Ingestion validates anchors and saves the explanations with the review. See the skill's [artifact format](../heptapod-skill/skills/heptapod/references/artifact-format.md#optional-inline-explanations) for the metadata contract.
