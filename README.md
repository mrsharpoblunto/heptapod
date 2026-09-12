# Heptapod

Heptapod turns a large pull request or branch diff into a verified, chronological review narrative. Every generated patch stack is checked to reconstruct the source comparison byte-for-byte, then stored in SQLite and presented through a Next.js review UI.

## Workspace

This repository is a pnpm monorepo:

- `packages/heptapod` — publishable CLI and shared TypeScript core (`@thestraylight/heptapod`)
- `packages/heptapod-web` — publishable Next.js review site (`@thestraylight/heptapod-web`)
- `packages/heptapod-skill` — publishable Codex/Claude skill package (`@thestraylight/heptapod-skill`)

```sh
pnpm install
pnpm check
pnpm dev:web
```

`pnpm dev:cli --help` executes the CLI TypeScript source directly. `pnpm dev:web` runs the Next.js development server with hot reload; it defaults to <http://localhost:3000>.

## Install in a repository

Install the CLI and site in the Git repository you want to review. Run every command from anywhere inside that repository; Heptapod resolves its Git root automatically.

```sh
pnpm add --save-dev @thestraylight/heptapod @thestraylight/heptapod-web @thestraylight/heptapod-skill
pnpm exec heptapod-skill install
```

Review data is shared automatically through `node_modules/.cache/heptapod/reviews.sqlite`. This is disposable, repository-local cache data, so it does not require another configuration flag or `.gitignore` entry.

The skill installer creates project-local links for both agents: `.agents/skills/heptapod` for Codex and `.claude/skills/heptapod` for Claude. It refuses to overwrite unrelated files; `pnpm exec heptapod-skill uninstall` removes only links owned by the installed package.

## CLI

```sh
pnpm exec heptapod capture --pr 12315
pnpm exec heptapod validate --id 12315
pnpm exec heptapod ingest --pr 12315
pnpm exec heptapod-web --port 3000
```

For a branch comparison, use `--rev '<base>...<target>'` with `capture` and `ingest`; its stable review ID is `<full-base-sha>/<full-target-sha>`. Narrative source files live beside the database under `node_modules/.cache/heptapod/runs/<review-id>` and are resolved automatically. `validate` accepts that emitted ID through `--id`.

Ingestion marks the review pending in SQLite, creates and later removes its own temporary worktree, and reconstructs every narrative step. Intermediate steps run the changed test fixtures introduced so far; the final step runs the complete suite. Observed output and unexpected failures are stored alongside the authored expectations.

Add an optional `.heptapod.json` at the repository root when tests need project-specific preparation or a custom runner. Commands are argv arrays, and `{files}` expands to the focused fixture paths during intermediate steps (and to no arguments for the final full-suite run):

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

- `prerequisites` prepare the initial worktree and run again when package dependency manifests change.
- `build` runs after a step's patch, once before that step's tests. A failed build is recorded and prevents execution of a stale binary. Later steps can build again.
- `runner.format`: `command` passes fixture paths to the command, preserving `{files}` and Node package discovery. `googletest` runs from the worktree root, adds `--gtest_filter` for each fixture, and parses GoogleTest failures. The final suite uses `--gtest_filter=*`. Empty or incomplete GoogleTest runs cannot pass.
- `fixtures.format`: `auto`, `javascript`, or `googletest`. The GoogleTest parser recognizes `TEST`, `TEST_F`, `TEST_P`, `TYPED_TEST`, and `TYPED_TEST_P`, including parameterized filter names. It reads standard macros from source; it does not expand custom macros or evaluate conditional compilation. Fixtures without recognized selectors are reported as not run.
- `worktreeDirectory` optionally places temporary worktrees below a path relative to the reviewed repository (or an absolute path). For Windows tools from WSL, use a directory on a Windows drive, such as `.worktrees`. Keep this directory ignored by Git.

Commands are argv arrays and run without an implicit shell. Use an explicit `bash -c` or another shell when needed. Each command receives `HEPTAPOD_REPOSITORY` (the original checkout) and `HEPTAPOD_WORKTREE` (the reconstructed checkout) for repository-specific setup. GoogleTest commands must not contain `{files}` or `--gtest_filter`; the adapter supplies the filter.

Fixture adapters in `src/tool/test-fixtures` own parsing, source locations, fingerprints, and optional test selectors. Runner adapters in `src/tool/test-runners` own command selection and result interpretation. Add an adapter to the corresponding registry to make another format selectable without changing narrative analysis or worktree execution.

When these workspace packages are locally linked, `pnpm exec heptapod` detects the source checkout and executes the TypeScript entrypoint through `tsx`, so CLI edits do not require a build. Use `pnpm exec heptapod-web-dev --port 3000` to run the linked web source with Next.js hot reload. The ordinary `heptapod-web` binary continues to serve the production build.

## Agent skill

For Codex, install the skill from `packages/heptapod-skill/skills/heptapod` in this repository. For Claude Code, add this repository as a plugin marketplace and install the `heptapod` plugin.

```sh
claude plugin marketplace add mrsharpoblunto/heptapod
claude plugin install heptapod@heptapod
```

### Complete step coverage

Every test, implementation, and refactor step must include every file from its diff in its structured content. Tests use `cases[].files`, refactors use interface sources and nested callsites, and implementations use `sections[].files`. Validation and ingestion reject omitted or unrelated files.

Implementation sections require a name, Markdown description, `critical` or `secondary` priority, and labeled files. Critical diffs open inline; Secondary files use a compact description/file/status list. Each implementation file belongs to exactly one section. Existing manifests using `focus` must be migrated to sections before ingestion.
