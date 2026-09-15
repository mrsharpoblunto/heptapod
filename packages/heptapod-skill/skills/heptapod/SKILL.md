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

Run every Heptapod command from inside the target repository. The repository must have `@thestraylight/heptapod` installed; use that repository-local package rather than `pnpm dlx`, and do not pass a repository path. The review site is a separate global service and is not installed in each repository.

Before capture or ingestion, register the current repository with the global service:

```bash
pnpm exec heptapod repo add --output ndjson
```

If this reports that the global service is unavailable, stop and tell the user to install and start it with `pnpm add --global @thestraylight/heptapod` followed by `heptapod service install` (or `heptapod service start` for the current login session). Do not install a global package or background service without the user's authorization.

When running Heptapod as an agent, always pass `--output ndjson`. Parse each complete stdout line as an event and give the user concise updates for stage transitions, material progress, completion, and failure. Do not echo repetitive progress or raw structured events. Stdout is reserved for NDJSON in this mode; subprocess diagnostics may still appear on stderr.

Choose exactly one source selector. Use `--pr <number>` for a GitHub pull request. Use `--rev '<base>...<target>'` for a local revision comparison. The PR review ID is its number; the revision review ID printed by `capture` is `<full-base-sha>/<full-target-sha>`.

When updating an existing review, first read its cached `narrative.json` and compare `source.base`, `source.head`, and `source.github.pullRequestUrl` with the current PR. Obtain the current comparison with `gh api repos/{owner}/{repo}/pulls/<number> --jq '{base: .base.sha, head: .head.sha, url: .html_url}'`; compare both full commit IDs, including the base. If they match and the metadata files are present, run `pnpm exec heptapod ingest --pr <number> --output ndjson` directly to rerun validation and tests using the existing narrative. Do not capture again, rewrite the narrative, or regenerate patches for an unchanged comparison. If ingestion fails, report or fix the specific validation/test issue; do not recapture merely because a test failed. If either revision changed or the metadata is missing, use the capture-and-author workflow.

For a new comparison, run the packaged Heptapod CLI:

```bash
pnpm exec heptapod capture \
  --pr <pull-request-number> \
  --output ndjson

# Or:
pnpm exec heptapod capture \
  --rev '<base-ref>...<target-ref>' \
  --output ndjson
```

`capture` immediately creates a database entry in the **Preparing review** state, prints the review `id`, absolute `metadataDirectory` (also available as `output`), and `narrative` manifest path, and pins full commit IDs and creates `source.diff`, `narrative.json`, `steps/`, and `diffs/` under `node_modules/.cache/heptapod/runs/<review-id>`. It refuses to overwrite existing artifacts. Treat the captured `source.diff` as the byte-level source of truth; do not edit it. Use the exact `metadataDirectory` from the command output for all narrative authoring; do not ask the user for or invent another artifact path.

Read [references/artifact-format.md](references/artifact-format.md) before authoring the manifest or step files.

## Construct the narrative

Inspect the source diff and enough surrounding code to understand intent, behavior, dependencies, and test coverage. Do a quick, focused history check for the main affected API or area: inspect a few recent commits for its key paths (for example, `git log -n 5 --oneline <pinned-base> -- path/to/area`) and open an earlier diff or linked PR only when it appears directly relevant. Use the pinned base when tracing prior history so later changes do not get presented as predecessors. Prioritize context such as the original design decision, an earlier migration, a regression, or a constraint this change responds to. Keep this bounded to the immediate area; do not survey the repository history or search broadly for background. If no useful connection emerges, omit historical context. When one does, include at most a sentence or two in the relevant step or inline explanation, link to the supporting commit/PR when a verified URL is available, and explain its bearing on this change. Distinguish documented intent from your inference.

Organize the smallest useful conceptual steps, not one step per file or commit. Prefer this shape when supported by the change:

1. Open with a description-only explanation of the problem and high-level approach. It contains no patch.
2. Introduce new or changed tests near the behavior they motivate. Describe each test area in terms of the broader functionality and risk it covers; do not merely enumerate literal test-case names, because Heptapod extracts those from the test source with the configured fixture parser.
3. Separate substantive implementation changes from interface migration. Put the core logic in focused implementation steps; put signature/type/interface changes and their mechanical caller updates in refactor steps.
4. Separate unrelated changes into independent steps.
5. Add test checkpoints at meaningful points. Automated and manual coverage share the Tests presentation and are distinguished by their section badges. A no-diff `manual` artifact step may carry concrete procedures and expected outcomes.

Every test, implementation, and refactor step must account for **all non-generated files in its diff** in its structured content. Test steps cover them through `cases[].files` (including test helpers and project setup); refactor steps through interface sources and nested callsites; implementation steps through `sections[].files`. A Markdown mention or the sidebar file list does not count. Validation and ingestion reject missing files and references outside the step diff.

Before assigning files to sections, inspect the target repository's current `.gitattributes`. Use Git's matching rules (`git check-attr -z --stdin linguist-generated`) to identify files excluded from review; honor nested overrides, `-linguist-generated`, and `linguist-generated=false`. Any specified value other than `false` enables this attribute. Do not infer exclusions from filenames alone, `.gitignore`, or `linguist-vendored`. The current repository rules apply even to older pinned comparisons; re-ingest after changing them.

Keep all generated changes in the immutable source comparison and their owning step patches so reconstruction and builds remain complete. Do not list generated files in test/supporting file lists, Critical/Secondary sections, interface sources, callsites, or repository file links in Markdown: validation and ingestion reject them. Explain the handwritten source that produces the output. A patch containing only generated files may use an empty `cases`, `sections`, or `interfaces` array, with an explanatory body; prefer keeping generated output beside its owning change when possible.

For implementation steps, use Critical and Secondary sections to group related files within that step, each with a name, Markdown explanation, and labeled file list - you can add as many critical and secondary groups as necessary to break up the files into groups of file changes serving a single purpose which can be clearly elaborated through the explanation paragraph. Critical files contain major behavior, contract, or risk changes the reviewer must inspect and open inline by default. Secondary files support that change, but are either lower risk or more trival changes that have a lower chance of requiring close scrutiny and appear in the compact description/file/status list. Explain why the files merit that priority and what their role is in the overall change; do not call files secondary merely to shorten the page. Place each file in exactly one section, but feel free to create multiple critical or secondary sections with their own explanation paragraph explaining that grouping of files. However you should generally favor isolated conceptual changes over a single step with many implementation sections. If a section needs an independent explanation or introduces another behavior, consider making it a separate step.

Add optional `explanations` to patch-bearing steps for individual lines or short line ranges where the code is non-obvious, complex, or needs a local explanation of how/why it fits the overall diff. These appear as small speech bubbles in the file diff. Explain intent, invariants, tradeoffs, ordering, or connections to other steps; do not restate the code, duplicate existing comments, or annotate every mechanical change. Use one to three concise sentences (with external Markdown links where useful), and omit explanations where the code and surrounding narrative are already clear.

Each explanation has `file` (the exact path used by this step's diff, including the destination path for renames), `side` (`RIGHT` for the step's after state; `LEFT` for the before state), `startLine`, optional inclusive `endLine`, and `text`. Lines are one-based source lines from that step's reconstructed state, not diff display rows or the final PR head. Prefer `RIGHT` for the introduced behavior and `LEFT` when explaining removed code. Every line in the range must appear on that side of this step's diff, including context lines; do not target binary, pure-move, or generated files. Keep explanations current when changing step patches and let `validate` catch stale anchors. See the artifact reference for an example.

For large changes, prefer multiple small red/green/refactor loops over one tests-first block followed by one implementation block. It is valid to define a focused set of tests, implement enough to pass them, change an interface, introduce the next test area, temporarily break earlier checks, and repair them in a later step. Tests may move between passing and failing as the intermediate contract evolves; record the expected or observed state honestly after every step.

Do not force those categories when the source does not support them. Omit a test step when there are no test changes. Keep setup, generated files, and mechanical formatting beside the conceptual change they enable unless they form a meaningful review step themselves.

For GitHub PRs, inspect the PR description, rendered attachment metadata, author comments, and commit messages for explanatory screenshots, videos, reference links, and manual verification that the author actually performed. Attach relevant references to context steps. Convert each manual procedure/result into a manual check and preserve its direct evidence—not merely the PR URL—in that check's `evidence` field. Mark playable recordings as `kind: video` so Heptapod renders them inline. Do not silently upgrade an assertion to `basis: observed` unless the PR evidence demonstrates that it ran. Heptapod also discovers GitHub-hosted screenshots and videos from the PR and makes them available in the Tests presentation.

Write explanatory content as Markdown files under `steps/`. Write each code-bearing step as a unified patch under `diffs/`. Patches are applied sequentially, so every patch must be based on the state produced by all preceding patches. It is valid for an intermediate state not to compile or for one step to revise a prior step, provided the final stack is exact.

Do not begin a step body with a heading that repeats its manifest `title`; the viewer already renders that title. Start with explanatory paragraph text. Add subheadings only after the opening prose when they materially organize the rest of the step.

Use Markdown links with repository-root-relative destinations when a source file helps explain the narrative, for example ``[`request.ts`](src/http/request.ts)``. If the destination resolves in the repository state at that step, Heptapod turns it into a compact filename-only file link that opens the source in the review pane. Include these links freely in context and other explanatory bodies, including for useful files that are not changed by the PR. Use ordinary HTTP(S) links for external references; do not use machine-local absolute paths.

Link to relevant external pages whenever they help a reviewer understand the change: related PRs or issues, standards or RFC sections, API documentation, and design discussions. This applies to step body text, section/interface descriptions, before/after explanations, and line-attached `explanations[].text`. Use descriptive Markdown links such as `[related retry PR](https://github.com/owner/repo/pull/123)` or `[API cancellation docs](https://example.com/api#cancellation)`, preferably to the specific relevant page or section. Explain the connection briefly in the surrounding text so the narrative still makes sense without opening the link. Use real references you have inspected; do not invent URLs or add unrelated links. Hint bubbles support explicit HTTP(S) Markdown links within their prose.

In cases where you make smaller changes that have a wide fan out across the codebase, or you're making repeated similar changes across many files - consider grouping those files in a refactor step. This way you can explain the before/after behavior and list the source of the changes, but not have to burden the user with going through all the mechanical callsite changes. For refactor steps, make each entry in `interfaces` one self-contained refactor section. Nest that interface's complete `callsites` list inside the same entry; never put callsites at step level. The `before` and `after` fields are Markdown, not implicitly code: choose prose, inline code, fenced code blocks with a language, or a combination based on what explains the interface change most clearly. When the refactor migrates callers in response to an API or implementation change that can be located in one file, set the interface's optional `file` to that source. When a collection of small migrations has no honest single source or parent change, omit `file` rather than choosing an arbitrary one. Give each callsite a `change` of `added`, `removed`, `changed`, or `moved` when its semantic migration is known so the viewer can distinguish the nature of the update; Heptapod falls back to the file-level change when this field is omitted.

Use the refactor `interfaces[].before` and `interfaces[].after` sections to show small, paired code examples when they help explain a new API or callsite convention. Show the old and new signature, options shape, invocation, or usage pattern with only the lines needed to make the migration clear. Base examples on the actual code in the corresponding step states, keep the same representative task on both sides, and add a short sentence when the reason for the convention is not obvious. Avoid copying whole implementations or repeating every mechanical caller edit. Put examples in fenced Markdown code blocks with an explicit language (such as `ts`, `js`, or `cpp`); the viewer renders each block at the full available width inside its Before or After panel with syntax highlighting. Use inline code for short identifiers within prose.

You can and should refer to previous or future steps within step explanations when necessary to help show how the steps interact with each other - you can use markdown hash url references to refer to other steps - use the name of the step in the link e.g. to navigate to the step renderer-interface use the #renderer-interface document hash.

When splitting is straightforward, extract complete file sections or independent hunks from `source.diff`. When steps touch overlapping lines, use an isolated temporary index to generate each patch between consecutive states. Do not create a Git worktree yourself and never modify the user's working tree merely to manufacture patches. Worktree creation belongs exclusively to the CLI's ingestion verifier.

Write the overall test summary for the user as a description of the changeset: the behavior covered, the risks checked, the results, and any limits on that evidence. Keep it agnostic of tooling. Do not mention Heptapod, ingestion, repeated test runs, or validation requirements in that summary. Apply the same rule to explanatory test prose and check details; operational instructions below govern your work, not the narrative's subject.

## Report verification state honestly

Every step has `automated` and `manual` check arrays describing the expected state _after that step_. Carry relevant checks forward so the viewer shows when each check should transition from failing to passing. Use `basis: observed` only for evidence that existed before ingestion; otherwise use `basis: expected`. During ingestion, Heptapod independently reconstructs every step in its own temporary worktree, runs changed test fixtures at intermediate steps, runs the complete suite at the final step, and stores the actual result beside these expectations. It also records parsed failures that do not match any expected failing check. Never edit the expectations after seeing the observed run merely to hide a mismatch.

If the repository has a `.heptapod.json`, treat its test prerequisites, build commands, runner format, and fixture format as authoritative; do not replace project-specific setup with guesses in the narrative or create a worktree yourself. Fixture formats own file recognition and test declarations; runner formats own command rules and result parsing. Use `vitest` for Vitest output and `googletest` for GoogleTest output. Both batch fixtures by default; respect `runner.batch` and `runner.rebuild` in the repository configuration. Automatic rebuilds are runner-specific: Vitest reuses builds across source-only changes but rebuilds for dependency metadata changes, while GoogleTest rebuilds after changed steps. Vitest projects that import compiled workspace packages or generated assets need `rebuild: "always"`; do not assume all Vitest projects can skip builds. Never change these settings merely to hide a failed build or test. The default `command` format records process exit status without extracting test failures from log text. Keep supporting files in test sections even when the fixture adapter does not classify them as runnable tests.

Use failing status deliberately when tests or behavior are introduced before their implementation. Use `not-run` when there is not enough evidence to infer a result, and explain blockers or important limitations in `detail`.

## Validate, then ingest

Validate repeatedly while constructing steps:

```bash
pnpm exec heptapod validate \
  --id <review-id> \
  --output ndjson
```

Fix patch application failures at the first failing step. A successful result proves both final Git tree identity and byte-for-byte equality with the captured canonical comparison.

Ingest only through the tool, which validates again and will not store an unverified walkthrough:

```bash
pnpm exec heptapod ingest \
  --pr <pull-request-number> \
  --output ndjson
```

For a revision review, replace `--pr <pull-request-number>` with `--rev '<base-ref>...<target-ref>'`. `ingest` resolves the cached narrative ID itself; it does not accept an arbitrary `--id`.

The review remains local while you author and validate metadata. Ingestion validates the matching cached narrative, tests every reconstructed step, uploads the versioned result to the global service, and emits `review.completed` with the complete URL. Give that URL to the user, along with the cached run directory, review ID, pinned base/head, narrative step count, exact-verification result, and any observed test mismatches. Do not claim completion if validation or upload fails.
