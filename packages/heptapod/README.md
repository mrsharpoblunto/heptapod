# @thestraylight/heptapod

The repository-local Heptapod CLI. Install it in the Git repository being reviewed, then run it from within that repository. It captures a comparison, validates an exact narrative patch stack, runs tests and structural diffs, retains run artifacts locally, and uploads the finished review to the global Heptapod site.

```sh
pnpm exec heptapod capture --pr 12315
pnpm exec heptapod validate --id 12315
pnpm exec heptapod ingest --pr 12315
```

Use `--rev '<base>...<target>'` instead of `--pr` for a branch comparison. Heptapod resolves the repository root with Git. Each narrative workspace stays at `node_modules/.cache/heptapod/runs/<review-id>`; the central site stores its own repository-scoped copy of the finished review payload.

During ingestion, Heptapod creates a temporary worktree at the pinned base and applies each step in order. Intermediate steps run only the changed test fixtures introduced so far; the final step runs the complete suite. It records observed results, expectation mismatches, raw output, and failures not represented by the authored expectations, then removes the worktree.

Ingestion also prepares persistent detached worktrees under the reviewed repository's `node_modules/.cache/heptapod/checkouts`. The small VS Code icon beside a file link opens its absolute path at the review head; files deleted from the head open at the base. The tooltip identifies the revision. These links open the endpoint revision even when a narrative step shows an intermediate state. Symlinks, submodules, and files absent from both endpoints have no editor link. Re-ingest older reviews to add links.

Editor checkouts are shared by reviews of the same revision and retained when a review is deleted. Clean checkouts are reused; if you edit one, ingestion creates a fresh checkout and preserves your edits. To reclaim space, remove unused checkouts with `git worktree remove <checkout-path>` (Git refuses dirty worktrees by default). Links require VS Code on the machine containing the checkout; remote browser clients and Windows editors accessing WSL paths need path mapping, which is not yet supported.

Structural diffs use [Difftastic](https://difftastic.wilfred.me.uk/) when it is installed on the host. The homepage includes an optional Difftastic checklist item with installation guidance. Ingestion checks `difft` on `PATH`, or the local executable selected by `diff.executable`, and uses standard diffs when it is unavailable. Heptapod does not package or download Difftastic. Versions without compatible JSON line alignment also fall back to standard diffs.

Ingestion runs Difftastic on each changed file's before/after snapshots at that narrative step. It stores validated line alignment and token changes in the review payload for immediate retrieval; viewing a review never invokes Difftastic. A cache under `node_modules/.cache/heptapod/difftastic` reuses successful results by contents, paths, Difftastic version, and adapter settings on subsequent ingestions. Failed results are retried on re-ingestion. This cache is shared across reviews and can be deleted when reclaiming space.

The viewer highlights syntactic changes and preserves line comments, test-case navigation, and expandable context. A **Show standard diff** toggle exposes formatting and the original patch. Difftastic is syntax-aware, not type-aware: it does not replace the proposed codebase symbol index. Pure renames keep the moved-file display; renamed files with edits show their diff.

Missing tools or snapshots, timeout/process errors, unsupported JSON, binary/unsupported files, and Difftastic's own parse/size/graph fallbacks use the standard diff for that file. The default timeout is 10 seconds per file, with a 1 MB input limit per side and a 3,000,000-node graph limit. One failure does not prevent other files or the review from being ingested. The original Git patches remain authoritative for verification, statistics, and publishing comments. Re-ingest existing reviews to generate structural diffs.

Optional `.heptapod.json` settings:

```json
{
  "diff": {
    "engine": "difftastic",
    "timeoutMs": 10000
  }
}
```

Set `diff.engine` to `standard` to disable generation. `diff.executable` is one executable name or path, not a shell command; relative paths resolve from the reviewed repository. Difftastic-specific terminal environment settings are ignored so ingestion does not silently omit comments or changes.

Install Difftastic using [the upstream instructions](https://difftastic.wilfred.me.uk/installation.html), for example `brew install difftastic` on macOS. Verify `difft --version` in the environment running Heptapod, reload the homepage to refresh its checklist, and re-ingest reviews to generate structural diffs.

Use an optional repository-root `.heptapod.json` for project-specific setup and test commands. Commands are argv arrays rather than shell strings. A standalone `{files}` argument expands to the focused fixtures for intermediate steps and disappears for the final full-suite run:

```json
{
  "test": {
    "prerequisites": [
      { "command": ["pnpm", "install", "--frozen-lockfile"] },
      { "command": ["pnpm", "run", "build:codegen"] }
    ],
    "runner": { "format": "vitest", "command": ["pnpm", "test", "{files}"], "batch": true, "rebuild": "auto" }
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
- `build` runs before the first tests that need it, then according to `runner.rebuild`. A failed build prevents tests from running against stale binaries and is retried at the next tested step. Unchanged tracked files retain their timestamps between steps so incremental compilers can reuse their outputs.
- `runner.format`: `command` passes fixture paths to the command, preserving `{files}` and Node package discovery. It uses the process exit status without interpreting log text. `vitest` interprets Vitest console results and uses a JSON report for individual fixture results in batches. `googletest` runs from the worktree root, combines fixture selectors in `--gtest_filter`, and maps completed test results back to their source fixtures. The final suite uses `--gtest_filter=*`. Empty or incomplete runs cannot pass.
- `runner.batch` defaults to `true` for Vitest and GoogleTest. Vitest groups fixtures by owning package and invokes each package once per batch (up to 100 files); GoogleTest combines selectors for up to 100 files, with smaller batches for long filters. Mixed passing/failing results remain distinct per fixture, while command output and process exit code are shared. Set `false` for wrappers that cannot accept multiple fixtures or reporter options. The generic `command` runner keeps one invocation per fixture because it cannot attribute batch results.
- `runner.rebuild` defaults to `auto`: each adapter decides from the paths changed since the last successful build. Vitest rebuilds for dependency metadata changes (`package.json`, lockfiles, workspace/package-manager settings), while GoogleTest and generic commands rebuild when the step changes files. `always` rebuilds after any changed step, including for Vitest projects that consume generated or compiled packages. `never` runs only the initial build (retrying it if it fails); use it only when later steps cannot invalidate the artifacts. Description/manual steps with no patch reuse the previous build.
- `fixtures.format`: `auto`, `javascript`, or `googletest`. The GoogleTest parser recognizes `TEST`, `TEST_F`, `TEST_P`, `TYPED_TEST`, and `TYPED_TEST_P`, including parameterized filter names. It reads standard macros from source; it does not expand custom macros or evaluate conditional compilation. Fixtures without recognized selectors are reported as not run.
- `worktreeDirectory` optionally places temporary worktrees below a path relative to the reviewed repository (or an absolute path). For Windows tools from WSL, use a directory on a Windows drive, such as `.worktrees`. Keep this directory ignored by Git.

Vitest batches add `default` and `json` reporters plus a unique temporary JSON output path; the configured command must forward those options to Vitest. Missing or unreadable reports fail the batch instead of marking every fixture as passing. The final step still runs the complete configured suite after the focused batch, so full-suite coverage and per-fixture results are both retained.

Rebuild policy controls only `test.build`; it cannot remove builds embedded in a test script. This repository explicitly uses `rebuild: "always"` because its tests import built workspace packages. Vitest can compile test sources directly, but that does not regenerate imported `dist` files or code-generated assets.

Commands are argv arrays and run without an implicit shell. Use an explicit `bash -c` or another shell when needed. Each command receives `HEPTAPOD_REPOSITORY` (the original checkout) and `HEPTAPOD_WORKTREE` (the reconstructed checkout) for repository-specific setup. GoogleTest commands must not contain `{files}` or `--gtest_filter`; the adapter supplies the filter.

Fixture adapters in `src/tool/test-fixtures` own file recognition (`supports` and `isFixture`), parsing, source locations, fingerprints, and optional test selectors. Filename conventions belong to the selected fixture format: a JavaScript-style test filename alone does not make a GoogleTest support file runnable. Runner adapters in `src/tool/test-runners` own project discovery, dependency-refresh rules, `requiresRebuild(pathsSinceBuild)`, command validation and selection, and output interpretation through `parseResult`. Adapters that support batching implement `batch` and `parseBatchResult` to select multiple fixtures and return individual results. Shared execution handles processes and exit status, then delegates test output to the selected adapter before truncating stored logs. Prerequisite and build output is never parsed as test results. Add an adapter to the corresponding registry to make another format selectable without changing configuration validation, narrative analysis, or worktree execution.

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

The CLI is a thin harness around `@thestraylight/heptapod-core`. `capture` creates a **Preparing review** database entry and prints its absolute `metadataDirectory` and `narrative` path. `heptapod prepare --pr <number> --agent <codex|claude>` runs capture, agent metadata authoring, validation, ingestion, and upload in sequence.
