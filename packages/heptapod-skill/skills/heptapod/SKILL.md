---
name: heptapod
description: Convert a large Git branch or PR comparison into a verified, chronological narrative of context, tests, focused implementation, interface/callsite refactors, and manual verification, then ingest it for the Heptapod review site. Use when a reviewer needs a logical path through a final diff rather than a conventional all-at-once diff. Requires locally available base and head commits; do not use for ordinary diff summaries that do not need reconstructable step patches.
---

# Heptapod

Build a reviewer-oriented account of how a change could have been developed cleanly. The account need not reproduce the author's actual chronology. It must preserve this invariant:

> Applying every patch-bearing step in narrative order to the pinned base commit produces the pinned head tree and the canonical source comparison byte-for-byte.

Never trade this invariant for a smoother story. The bundled validator is the authority.

## Start from an immutable comparison

Resolve a PR or branch comparison to locally available base and head commits. For a PR, identify the PR's actual base commit and head commit rather than assuming the current default branch is its base. Fetch missing refs only when that is within the user's authorization.

Run every Heptapod command from inside the target repository. The repository must have `@thestraylight/heptapod` and `@thestraylight/heptapod-web` installed; use those repository-local packages rather than `pnpm dlx`, and do not pass a repository path.

Choose exactly one source selector. Use `--pr <number>` for a GitHub pull request. Use `--rev '<base>...<target>'` for a local revision comparison. The PR review ID is its number; the revision review ID printed by `capture` is `<full-base-sha>/<full-target-sha>`.

Run the packaged Heptapod CLI:

```bash
pnpm exec heptapod capture \
  --pr <pull-request-number>

# Or:
pnpm exec heptapod capture \
  --rev '<base-ref>...<target-ref>'
```

`capture` pins full commit IDs and creates `source.diff`, `narrative.json`, `steps/`, and `diffs/` under `node_modules/.cache/heptapod/runs/<review-id>`. It refuses to overwrite existing artifacts. Treat the captured `source.diff` as the byte-level source of truth; do not edit it. Use this resolved run directory for all narrative authoring; do not ask the user for or invent another artifact path.

Read [references/artifact-format.md](references/artifact-format.md) before authoring the manifest or step files.

## Construct the narrative

Inspect the source diff and enough surrounding code to understand intent, behavior, dependencies, and test coverage. Organize the smallest useful conceptual steps, not one step per file or commit. Prefer this shape when supported by the change:

1. Open with a description-only explanation of the problem and high-level approach. It contains no patch.
2. Introduce new or changed tests near the behavior they motivate. Describe each test area in terms of the broader functionality and risk it covers; do not merely enumerate literal test-case names, because Heptapod extracts those from the test source with the configured fixture parser.
3. Separate substantive implementation changes from interface migration. Put the core logic in focused implementation steps; put signature/type/interface changes and their mechanical caller updates in refactor steps.
4. Separate unrelated changes into independent steps.
5. Add test checkpoints at meaningful points. Automated and manual coverage share the Tests presentation and are distinguished by their section badges. A no-diff `manual` artifact step may carry concrete procedures and expected outcomes.

Every test, implementation, and refactor step must account for **all non-generated files in its diff** in its structured content. Test steps cover them through `cases[].files` (including test helpers and project setup); refactor steps through interface sources and nested callsites; implementation steps through `sections[].files`. A Markdown mention or the sidebar file list does not count. Validation and ingestion reject missing files and references outside the step diff.

Before assigning files to sections, inspect the target repository's current `.gitattributes`. Use Git's matching rules (`git check-attr -z --stdin linguist-generated`) to identify files excluded from review; honor nested overrides, `-linguist-generated`, and `linguist-generated=false`. Any specified value other than `false` enables this attribute. Do not infer exclusions from filenames alone, `.gitignore`, or `linguist-vendored`. The current repository rules apply even to older pinned comparisons; re-ingest after changing them.

Keep all generated changes in the immutable source comparison and their owning step patches so reconstruction and builds remain complete. Do not list generated files in test/supporting file lists, Critical/Secondary sections, interface sources, callsites, or repository file links in Markdown: validation and ingestion reject them. Explain the handwritten source that produces the output. A patch containing only generated files may use an empty `cases`, `sections`, or `interfaces` array, with an explanatory body; prefer keeping generated output beside its owning change when possible.

For implementation steps, use Critical and Secondary sections, each with a name, Markdown explanation, and labeled file list. Critical files contain the behavior, contract, or risk the reviewer must inspect and open inline by default. Secondary files support that change and appear in the compact description/file/status list. Explain why the files merit that priority; do not call files secondary merely to shorten the page. Place each file in exactly one section. Favor isolated conceptual changes over a single step with many implementation sections. If a section needs an independent explanation or introduces another behavior, consider making it a separate step.

For large changes, prefer multiple small red/green/refactor loops over one tests-first block followed by one implementation block. It is valid to define a focused set of tests, implement enough to pass them, change an interface, introduce the next test area, temporarily break earlier checks, and repair them in a later step. Tests may move between passing and failing as the intermediate contract evolves; record the expected or observed state honestly after every step.

Do not force those categories when the source does not support them. Omit a test step when there are no test changes. Keep setup, generated files, and mechanical formatting beside the conceptual change they enable unless they form a meaningful review step themselves.

For GitHub PRs, inspect the PR description, rendered attachment metadata, author comments, and commit messages for explanatory screenshots, videos, reference links, and manual verification that the author actually performed. Attach relevant references to context steps. Convert each manual procedure/result into a manual check and preserve its direct evidence—not merely the PR URL—in that check's `evidence` field. Mark playable recordings as `kind: video` so Heptapod renders them inline. Do not silently upgrade an assertion to `basis: observed` unless the PR evidence demonstrates that it ran. Heptapod also discovers GitHub-hosted screenshots and videos from the PR and makes them available in the Tests presentation.

Write explanatory content as Markdown files under `steps/`. Write each code-bearing step as a unified patch under `diffs/`. Patches are applied sequentially, so every patch must be based on the state produced by all preceding patches. It is valid for an intermediate state not to compile or for one step to revise a prior step, provided the final stack is exact.

Do not begin a step body with a heading that repeats its manifest `title`; the viewer already renders that title. Start with explanatory paragraph text. Add subheadings only after the opening prose when they materially organize the rest of the step.

Use Markdown links with repository-root-relative destinations when a source file helps explain the narrative, for example ``[`request.ts`](src/http/request.ts)``. If the destination resolves in the repository state at that step, Heptapod turns it into a compact filename-only file link that opens the source in the review pane. Include these links freely in context and other explanatory bodies, including for useful files that are not changed by the PR. Use ordinary HTTP(S) links for external references; do not use machine-local absolute paths.

For refactor steps, make each entry in `interfaces` one self-contained refactor section. Nest that interface's complete `callsites` list inside the same entry; never put callsites at step level. The `before` and `after` fields are Markdown, not implicitly code: choose prose, inline code, fenced code blocks with a language, or a combination based on what explains the interface change most clearly. When the refactor migrates callers in response to an API or implementation change that can be located in one file, set the interface's optional `file` to that source. When a collection of small migrations has no honest single source or parent change, omit `file` rather than choosing an arbitrary one. Give each callsite a `change` of `added`, `removed`, or `changed` when its semantic migration is known so the viewer can distinguish the nature of the update; Heptapod falls back to the file-level change when this field is omitted.

When splitting is straightforward, extract complete file sections or independent hunks from `source.diff`. When steps touch overlapping lines, use an isolated temporary index to generate each patch between consecutive states. Do not create a Git worktree yourself and never modify the user's working tree merely to manufacture patches. Worktree creation belongs exclusively to the CLI's ingestion verifier.

Write the overall test summary for the user as a description of the changeset: the behavior covered, the risks checked, the results, and any limits on that evidence. Keep it agnostic of tooling. Do not mention Heptapod, ingestion, repeated test runs, or validation requirements in that summary. Apply the same rule to explanatory test prose and check details; operational instructions below govern your work, not the narrative's subject.

## Report verification state honestly

Every step has `automated` and `manual` check arrays describing the expected state *after that step*. Carry relevant checks forward so the viewer shows when each check should transition from failing to passing. Use `basis: observed` only for evidence that existed before ingestion; otherwise use `basis: expected`. During ingestion, Heptapod independently reconstructs every step in its own temporary worktree, runs changed test fixtures at intermediate steps, runs the complete suite at the final step, and stores the actual result beside these expectations. It also records parsed failures that do not match any expected failing check. Never edit the expectations after seeing the observed run merely to hide a mismatch.

If the repository has a `.heptapod.json`, treat its test prerequisites, build commands, runner format, and fixture format as authoritative; do not replace project-specific setup with guesses in the narrative or create a worktree yourself.

Use failing status deliberately when tests or behavior are introduced before their implementation. Use `not-run` when there is not enough evidence to infer a result, and explain blockers or important limitations in `detail`.

## Validate, then ingest

Validate repeatedly while constructing steps:

```bash
pnpm exec heptapod validate \
  --id <review-id>
```

Fix patch application failures at the first failing step. A successful result proves both final Git tree identity and byte-for-byte equality with the captured canonical comparison.

Ingest only through the tool, which validates again and will not store an unverified walkthrough:

```bash
pnpm exec heptapod ingest \
  --pr <pull-request-number> \
  --site-url <heptapod-base-url>
```

For a revision review, replace `--pr <pull-request-number>` with `--rev '<base-ref>...<target-ref>'`. `ingest` resolves the cached narrative ID itself; it does not accept an arbitrary `--id`.

The command first creates a pending database record, then finds the matching cached narrative, validates it, tests every reconstructed step, and prints the review's complete URL. The Heptapod site reflects live ingestion progress and re-ingested changes without regenerating a static asset. Give that complete URL to the user, along with the cached run directory, review ID, pinned base/head, narrative step count, exact-verification result, and any observed test mismatches. Do not claim completion if validation fails.

If no Heptapod site is already running, start the separately packaged site from the same repository with `pnpm exec heptapod-web --port <port>`. The CLI and site automatically share `node_modules/.cache/heptapod/reviews.sqlite` beneath the Git root; do not ask the user for a database path.
