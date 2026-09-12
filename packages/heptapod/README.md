# @thestraylight/heptapod

The Heptapod CLI and shared TypeScript core. Install it in the Git repository being reviewed, then run it from within that repository. It captures a comparison, validates an exact narrative patch stack, and ingests the resulting review into SQLite.

```sh
pnpm exec heptapod capture --pr 12315
pnpm exec heptapod validate --id 12315
pnpm exec heptapod ingest --pr 12315
```

Use `--rev '<base>...<target>'` instead of `--pr` for a branch comparison. Heptapod resolves the repository root with Git. It stores the SQLite database at `node_modules/.cache/heptapod/reviews.sqlite` and each narrative workspace at `node_modules/.cache/heptapod/runs/<review-id>`. The separately installed `@thestraylight/heptapod-web` package reads the same cache automatically.

During ingestion, Heptapod creates a temporary worktree at the pinned base and applies each step in order. Intermediate steps run only the changed test fixtures introduced so far; the final step runs the complete suite. It records observed results, expectation mismatches, raw output, and failures not represented by the authored expectations, then removes the worktree.

Use an optional repository-root `.heptapod.json` for project-specific setup and test commands. Commands are argv arrays rather than shell strings. A standalone `{files}` argument expands to the focused fixtures for intermediate steps and disappears for the final full-suite run:

```json
{
  "test": {
    "prerequisites": [
      { "command": ["pnpm", "install", "--frozen-lockfile"] },
      { "command": ["pnpm", "run", "build:codegen"] }
    ],
    "runner": { "command": ["pnpm", "test", "{files}"] }
  }
}
```

When this package is locally linked from a source checkout, the `heptapod` binary automatically runs `src/tool/cli.ts` through `tsx`. Re-run the command after a source edit; rebuilding `dist` is unnecessary.
