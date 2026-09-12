# Heptapod

Heptapod turns a large pull request or branch diff into a verified, chronological review narrative. Every generated patch stack is checked to reconstruct the source comparison byte-for-byte, then stored in SQLite and presented through a Next.js review UI.

## Workspace

This repository is a pnpm monorepo:

- `packages/heptapod-core` — shared capture, validation, ingestion, storage, and agent APIs (`@thestraylight/heptapod-core`)
- `packages/heptapod` — lightweight CLI harness (`@thestraylight/heptapod`)
- `packages/heptapod-api` — background API sidecar and job workers (`@thestraylight/heptapod-api`)
- `packages/heptapod-web` — publishable Next.js review site (`@thestraylight/heptapod-web`)
- `packages/heptapod-skill` — publishable Codex/Claude skill package (`@thestraylight/heptapod-skill`)

```sh
pnpm install
pnpm check
pnpm dev:web
```

`pnpm dev:cli --help` executes the CLI TypeScript source directly. `pnpm dev:web` runs the Next.js development server with hot reload; it defaults to <http://localhost:3000> and starts the API sidecar on port 3001 (the web port plus one). The launcher builds core/API first; restart it after changing those packages.

## Install in a repository

Install the CLI and site in the Git repository you want to review. Run every command from anywhere inside that repository; Heptapod resolves its Git root automatically.

```sh
pnpm add --save-dev @thestraylight/heptapod @thestraylight/heptapod-web @thestraylight/heptapod-skill
pnpm exec heptapod-skill install
```

Review data is shared automatically through `node_modules/.cache/heptapod/reviews.sqlite`. This is disposable, repository-local cache data, so it does not require another configuration flag or `.gitignore` entry.

The skill installer creates project-local links for both agents: `.agents/skills/heptapod` for Codex and `.claude/skills/heptapod` for Claude. It refuses to overwrite unrelated files; `pnpm exec heptapod-skill uninstall` removes only links owned by the installed package.

The homepage checks Git, GitHub CLI authentication, installed Heptapod skills, and Codex/Claude Code authentication. Imported reviews appear first. When a supported agent is installed, open PRs that have not been imported appear below, newest first, loading more pages as you scroll. Enable **Include closed and merged** to include completed PRs as well; it is off by default. Choose an authenticated agent from **Import** to capture metadata, author and validate the narrative, then ingest it automatically. Setup failures include repair instructions.

Setup checks and GitHub identity requests start as server promises and stream through Suspense. Preparation, ingestion, and GitHub draft publication run in the API sidecar's workers; the browser polls the sidecar for progress instead of holding a Next.js route open.

Configure the default import agent and dropdown order in `.heptapod.json`:

```json
{ "agents": { "preferenceOrder": ["claude", "codex"] } }
```

The first installed, authenticated agent with its skill installed is the primary **Import** action. Omitted agents follow in the default order (Codex, then Claude Code). The dropdown only appears when multiple agents are installed and authenticated.

## CLI

```sh
pnpm exec heptapod capture --pr 12315
pnpm exec heptapod validate --id 12315
pnpm exec heptapod ingest --pr 12315
pnpm exec heptapod-web --port 3000
```

For a branch comparison, use `--rev '<base>...<target>'` with `capture` and `ingest`; its stable review ID is `<full-base-sha>/<full-target-sha>`. Narrative source files live beside the database under `node_modules/.cache/heptapod/runs/<review-id>` and are resolved automatically. `validate` accepts that emitted ID through `--id`.

Capture creates a **Preparing review** entry in SQLite and prints its absolute `metadataDirectory` and `narrative` path. Ingestion changes the review to pending, creates and later removes its own temporary worktree, and reconstructs every narrative step. Intermediate steps run the changed test fixtures introduced so far; the final step runs the complete suite. Observed output and unexpected failures are stored alongside the authored expectations.

Add an optional `.heptapod.json` at the repository root when tests need project-specific preparation or a custom runner. Commands are argv arrays, and `{files}` expands to the focused fixture paths during intermediate steps (and to no arguments for the final full-suite run):

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

When these workspace packages are locally linked, `pnpm exec heptapod` detects the source checkout and executes the TypeScript entrypoint through `tsx`, so CLI edits do not require a build. Use `pnpm exec heptapod-web-dev --port 3000` to run the linked web source with Next.js hot reload. The ordinary `heptapod-web` binary continues to serve the production build.

## GitHub review drafts

Install [GitHub CLI](https://cli.github.com/) on the machine running Heptapod, then run `gh auth login` and `gh auth status`. The active GitHub account must have access to review the PR. Authentication is shared across repositories.

For GitHub reviews, hover over a Markdown section, file link, test declaration, or refactor item to reveal its comment button in the left gutter. Saved comments keep a filled button visible. Hover to preview or click to edit in the compact, draggable plain text editor. Enter or ✓ saves and hides it; Shift+Enter adds a line. Clicking outside saves nonempty text and dismisses the editor; × removes the comment.

Click or drag line numbers in a changed file to open an editable inline comment row. Overlapping comments are combined into that range. Inline comments save automatically, remain editable, and have an × to remove them.

The final **Review** step puts all section comments into one editable summary, followed by file comments and syntax-highlighted inline diffs. File headers open the full source in the right pane. Comments and summary edits are saved in the repository's SQLite review database. **Publish draft comments** creates a [pending GitHub review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) and opens the PR's files page. Submit the finished review on GitHub. These controls are hidden for revision comparisons without a GitHub PR.

Line ranges are mapped from the narrative to the captured PR diff. If a range no longer exists there, the preview asks you to choose another range or move the comment to the file. Publication checks that the PR still has the captured head commit. An interrupted publish can be retried without duplicating comments already sent.

## Agent skill

For Codex, install the skill from `packages/heptapod-skill/skills/heptapod` in this repository. For Claude Code, add this repository as a plugin marketplace and install the `heptapod` plugin.

```sh
claude plugin marketplace add mrsharpoblunto/heptapod
claude plugin install heptapod@heptapod
```

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
