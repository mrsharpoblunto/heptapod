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
    "runner": { "format": "vitest", "command": ["pnpm", "test", "{files}"] }
  }
}
```


Test runners and fixture parsers are selected independently. Existing command-only configurations still work; `runner.format` defaults to `command` and `fixtures.format` defaults to `auto` (JavaScript/TypeScript or C++ GoogleTest by extension).

For a compiled GoogleTest suite:

```json
{
  "test": {
    "fixtures": { "format": "googletest" },
    "prerequisites": [{ "command": ["cmake", "-S", ".", "-B", "build"] }],
    "build": [{ "command": ["cmake", "--build", "build"] }],
    "runner": {
      "format": "googletest",
      "command": ["./build/tests"]
    }
  }
}
```

- `prerequisites` prepare the initial worktree and run again when the runner adapter identifies dependency changes.
- `build` runs after a step's patch, once before that step's tests. A failed build is recorded and prevents execution of a stale binary. Later steps can build again.
- `runner.format`: `command` passes fixture paths to the command, preserving `{files}` and Node package discovery. It uses the process exit status without interpreting log text. `vitest` adds Vitest console-result parsing, including named failures and empty or incomplete runs; use a console reporter such as `default` or `verbose`. `googletest` runs from the worktree root, adds `--gtest_filter` for each fixture, and parses GoogleTest failures. The final suite uses `--gtest_filter=*`. Empty or incomplete GoogleTest runs cannot pass.
- `fixtures.format`: `auto`, `javascript`, or `googletest`. The GoogleTest parser recognizes `TEST`, `TEST_F`, `TEST_P`, `TYPED_TEST`, and `TYPED_TEST_P`, including parameterized filter names. It reads standard macros from source; it does not expand custom macros or evaluate conditional compilation. Fixtures without recognized selectors are reported as not run.
- `worktreeDirectory` optionally places temporary worktrees below a path relative to the reviewed repository (or an absolute path). For Windows tools from WSL, use a directory on a Windows drive, such as `.worktrees`. Keep this directory ignored by Git.

Commands are argv arrays and run without an implicit shell. Use an explicit `bash -c` or another shell when needed. Each command receives `HEPTAPOD_REPOSITORY` (the original checkout) and `HEPTAPOD_WORKTREE` (the reconstructed checkout) for repository-specific setup. GoogleTest commands must not contain `{files}` or `--gtest_filter`; the adapter supplies the filter.

Fixture adapters in `src/tool/test-fixtures` own file recognition (`supports` and `isFixture`), parsing, source locations, fingerprints, and optional test selectors. Filename conventions belong to the selected fixture format: a JavaScript-style test filename alone does not make a GoogleTest support file runnable. Runner adapters in `src/tool/test-runners` own project discovery, dependency-refresh rules, command validation and selection, and output interpretation through `parseResult`. Shared execution handles processes and exit status, then delegates test output to the selected adapter before truncating stored logs. Prerequisite and build output is never parsed as test results. Add an adapter to the corresponding registry to make another format selectable without changing configuration validation, narrative analysis, or worktree execution.

When this package is locally linked from a source checkout, the `heptapod` binary automatically runs `src/tool/cli.ts` through `tsx`. Re-run the command after a source edit; rebuilding `dist` is unnecessary.

### Complete step coverage

Every test, implementation, and refactor step must include every non-generated file from its diff in its structured content. Tests use `cases[].files`, refactors use interface sources and nested callsites, and implementations use `sections[].files`. Validation and ingestion reject omitted or unrelated files.

Implementation sections require a name, Markdown description, `critical` or `secondary` priority, and labeled files. Critical diffs open inline; Secondary files use a compact description/file/status list. Each implementation file belongs to exactly one section. Existing manifests using `focus` must be migrated to sections before ingestion.

### Generated files

Heptapod uses GitHub's `linguist-generated` Git attribute to hide generated files from review content, file lists, and diff statistics. For example, add these rules to the target repository's `.gitattributes`:

```gitattributes
*.generated linguist-generated=true
*.generated.* linguist-generated=true
```

Git resolves the patterns, nested `.gitattributes`, and overrides such as `-linguist-generated` or `linguist-generated=false`. Heptapod uses the target repository's current attributes, including local edits, even for older pinned comparisons. Re-ingest existing reviews after changing the rules. GitHub applies committed rules to hide generated diffs by default. `linguist-vendored` and `.gitignore` do not hide tracked review files.

Keep generated changes in `source.diff` and their owning step patches: exact reconstruction and builds still include them. Omit them from test/supporting file lists, Critical/Secondary sections, interface sources, callsites, and repository file links in Markdown. Validation and ingestion reject explicit references to excluded files. Coverage still requires every visible changed file; a step containing only generated changes uses an empty `cases`, `sections`, or `interfaces` array.

The CLI is a thin harness around `@thestraylight/heptapod-core`, shared with the web API sidecar. `capture` creates a **Preparing review** database entry and prints its absolute `metadataDirectory` and `narrative` path. `heptapod prepare --pr <number> --agent <codex|claude>` runs capture, agent metadata authoring, validation, and ingestion in sequence.
