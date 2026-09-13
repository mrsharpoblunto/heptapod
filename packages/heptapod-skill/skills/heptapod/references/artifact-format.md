# Artifact format

The CLI stores each review's artifact directory at `node_modules/.cache/heptapod/runs/<review-id>`. It contains one JSON manifest, Markdown narrative bodies, per-step unified diffs, and the immutable source diff:

```text
node_modules/.cache/heptapod/runs/my-review/
├── narrative.json
├── source.diff
├── steps/
│   ├── 01-problem.md
│   └── 03-implementation.md
└── diffs/
    ├── 02-tests.diff
    ├── 03-implementation.diff
    └── 04-refactor.diff
```

All paths in `narrative.json` are relative to the artifact directory and must stay inside it. Markdown image links may point to local PNG, JPEG, GIF, WebP, AVIF, or SVG files inside the artifact directory; ingestion embeds them as data URLs. HTTP(S) images remain external.

Markdown bodies may link to source files using repository-root-relative destinations, such as ``[`upload.ts`](src/upload.ts)``. During ingestion, links that resolve in the reconstructed repository state after that step become compact file controls in the viewer. They can reference unchanged files as well as files in the step diff. Unresolved paths remain ordinary Markdown links.

External references are welcome in step bodies and other explanations, including section/interface descriptions, before/after text, and inline `explanations[].text`. Use descriptive Markdown links to related PRs, standards sections, API documentation, or design discussions; explain why the reference matters and prefer the specific relevant page or anchor. For example: `Retries follow the [HTTP idempotency rules](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).` Hint bubbles render HTTP(S) Markdown links as clickable links that open in a new tab.

Before authoring, briefly inspect a few prior commits/diffs for the main affected paths at the pinned base, following a related PR only when directly relevant. Include at most one or two sentences of historical context where an earlier design, migration, regression, or constraint helps explain this change. Link to the supporting commit/PR when available; distinguish evidence from inference and omit background that does not help the review. This is a focused check, not a history survey.

## Manifest

```json
{
  "schemaVersion": 1,
  "title": "Add bounded retries to the upload client",
  "summary": "Codify the timeout, implement retry policy, then migrate callers.",
  "source": {
    "base": "40-character base commit ID",
    "head": "40-character head commit ID",
    "diff": "source.diff",
    "files": [
      { "status": "M", "path": "src/upload.ts" },
      { "status": "R100", "from": "src/old.ts", "path": "src/new.ts" }
    ]
  },
  "steps": []
}
```

`capture --pr <number>` uses the PR number as `<review-id>`. `capture --rev '<base>...<target>'` resolves immutable commits and uses `<full-base-sha>/<full-target-sha>`. `capture` creates and pins `source`; preserve it unchanged. Step IDs must be unique and stable because the review viewer uses them for navigation.

## Common step fields

Every step contains:

```json
{
  "id": "bounded-retry-policy",
  "title": "Retry transient upload failures",
  "kind": "implementation",
  "body": "steps/03-retry-policy.md",
  "diff": "diffs/03-retry-policy.diff",
  "checks": {
    "automated": [
      {
        "label": "UploadClient retry tests",
        "status": "passing",
        "basis": "observed",
        "command": "npm test -- upload-client",
        "detail": "Transient errors recover within the retry limit."
      }
    ],
    "manual": [
      {
        "label": "Upload recovers after a transient 503",
        "status": "passing",
        "basis": "expected",
        "detail": "The retry path is now implemented; this has not been exercised manually.",
        "evidence": [
          {
            "kind": "link",
            "label": "Author's staging verification",
            "url": "https://github.com/example/repo/pull/42#issuecomment-123"
          }
        ]
      }
    ]
  }
}
```

`body` is optional for patch-bearing steps and required for description/manual steps. When present, it must name a `.md` file. `diff` is required for tests/refactor/implementation and forbidden for description/manual.

Allowed check statuses are `passing`, `failing`, `not-run`, `blocked`, and `not-applicable`. The required `basis` is `observed` or `expected`. `command`, `detail`, and `evidence` are optional. Evidence entries use `kind: "image"`, `kind: "video"`, or `kind: "link"` plus `label`, `url`, and an optional `sourceUrl`. Use the direct GitHub attachment URL for screenshot or video evidence rather than substituting the enclosing PR URL; videos render with inline playback controls.

Any step may also have a top-level `evidence` array with the same shape. Use it for reference screenshots and links from the PR description, author comments, or commit messages that clarify a context step. Use check-level evidence when it proves a specific manual procedure.

## Optional inline explanations

Patch-bearing steps may include an `explanations` array:

```json
{
  "explanations": [
    {
      "file": "src/upload.ts",
      "side": "RIGHT",
      "startLine": 42,
      "endLine": 46,
      "text": "The same request key survives retries so a timeout after a successful upload cannot create a second object. The caller migration in the next step relies on this guarantee."
    }
  ]
}
```

`file` must be a non-generated file in that step's patch. For renamed files, use the destination path on either side. `LEFT` refers to the source immediately before the step, `RIGHT` immediately after it. `startLine` is a positive, one-based source line number. `endLine` is inclusive and defaults to `startLine`. The entire range must be present in the patch on the selected side (changed or context lines). Binary files and pure moves have no annotatable diff lines. `text` is non-empty prose with optional HTTP(S) Markdown links, limited to 2,000 characters including link markup; aim for one to three sentences. Other markup remains literal text in hint bubbles.

Use these sparingly to explain difficult code, intent, invariants, or the relationship to the larger change. They are authoring metadata, not source-code edits or GitHub reviewer comments. Omit the array when it adds no useful context. The viewer places a bubble at the first line, reveals the text on hover/focus/tap, and highlights the range while open. Multiple explanations starting on the same displayed row share a bubble.

## Description and manual steps

These contain explanatory Markdown and no diff:

```json
{
  "id": "problem-and-approach",
  "title": "Understand the timeout failure",
  "kind": "description",
  "body": "steps/01-problem.md",
  "checks": { "automated": [], "manual": [] }
}
```

The first step must be a description. A manual step's Markdown should include prerequisites, actions, and observable expected results. Add one manual check per procedure; Heptapod presents these alongside automated test areas under Tests, distinguished by `Manual test` and `Automated test` badges.

## Test steps

Keep the overall test summary and explanatory prose about the changeset's behavior, coverage, results, and limitations. Do not discuss Heptapod, repeated execution, ingestion, or validation requirements.

The `cases` entries describe broad test areas, not individual `it()`/`test()` names. Explain the functionality and risk covered without restating the literal cases; Heptapod parses those names and their added/removed/changed/moved status from the before/after source using the configured fixture parser. Each area must link to at least one file changed by the step patch. Together, the areas must cover every non-generated changed file, including helpers, fixtures, and project setup. Explain supporting files in the relevant area even when they contain no named test cases:

```json
{
  "id": "codify-timeout",
  "title": "Describe retry behavior under timeout",
  "kind": "tests",
  "body": "steps/02-tests.md",
  "diff": "diffs/02-tests.diff",
  "cases": [
    {
      "name": "Upload retry behavior",
      "description": "Covers transient transport failures, retry bounds, and successful recovery without duplicating an upload.",
      "change": "New regression coverage; expected to fail until step 3.",
      "files": ["test/upload-client.test.ts"]
    }
  ],
  "checks": { "automated": [], "manual": [] }
}
```

## Refactor steps

Describe the changed interface separately from every updated callsite. Interface sources and nested callsites together must cover every non-generated file in this step's patch. Each reference must be a path in that patch.

```json
{
  "id": "thread-retry-policy",
  "title": "Pass retry policy through upload callers",
  "kind": "refactor",
  "body": "steps/04-refactor.md",
  "diff": "diffs/04-refactor.diff",
  "interfaces": [
    {
      "name": "upload(blob, retryPolicy)",
      "description": "The caller now supplies an explicit policy.",
      "file": "src/upload.ts",
      "before": "The retry policy was implicit:\n\n```ts\nupload(blob)\n```",
      "after": "The caller now makes the policy explicit:\n\n```ts\nupload(blob, retryPolicy)\n```",
      "callsites": [
        { "label": "Profile image uploader", "file": "src/profile.ts", "change": "changed" },
        { "label": "Attachment uploader", "file": "src/attachments.ts", "change": "added" }
      ]
    }
  ],
  "checks": { "automated": [], "manual": [] }
}
```

`before`, `after`, and interface `file` are optional. `before` and `after` contain Markdown: use normal prose, inline code, fenced code with an explicit language, or both. Do not assume the viewer treats the whole value as source code. Use `file` as the source only when a specific API or implementation file triggers that section's caller migrations. Omit it for a distributed set of small migrations with no single source; the viewer then omits the Source group. `interfaces` must be non-empty unless the entire patch is generated; every interface requires a `callsites` array, and the step must contain at least one callsite across its interface sections. Step-level `callsites` are invalid. `callsites[].change` is optional and may be `added`, `removed`, `changed`, or `moved`; when omitted, Heptapod infers it from whether the containing file was added, deleted, modified, or renamed. Rename metadata takes precedence over a declared change.

For new APIs and callsite conventions, prefer small paired examples in `interfaces[].before` and `interfaces[].after` when code makes the migration clearer than prose alone. Show a representative old/new signature, options object, or call for the same task, using the actual API from each step state. Keep examples focused on the changed convention; explain any non-obvious reason in a short accompanying sentence. Fenced blocks with an explicit language render as full-width, syntax-highlighted blocks inside their respective Before/After containers. Inline backticks render inline code, so use fences for multiline examples. In JSON strings, encode line breaks as `\n`, as in the example above.

## Implementation steps

`sections` replaces `focus`. Every section requires a non-empty `name`, `description` (inline Markdown), `priority` (`critical` or `secondary`), and `files` list. Each file requires a descriptive `label` and repository-relative `file`; optional `change` uses the same added/removed/changed/moved values as refactor callsites. Relative images in section Markdown resolve beside the step's body file, or beside the manifest when no body is present.

Critical sections show a Critical badge and every file's inline diff open by default. Secondary sections use the same description/file/status list as refactor callsites, with diffs opened on selection. Explain why each group needs its priority. Every non-generated changed file must appear **exactly once** across the sections. Unknown, omitted, and duplicate files are rejected; legacy `focus` manifests must be migrated. Prefer a few cohesive sections and split independent changes into separate steps.

```json
{
  "id": "implement-retries",
  "title": "Retry transient failures with a fixed bound",
  "kind": "implementation",
  "body": "steps/03-implementation.md",
  "diff": "diffs/03-implementation.diff",
  "sections": [
    {
      "name": "Retry bounds and recovery",
      "priority": "critical",
      "description": "The retry loop determines **which failures recover** and enforces the attempt limit. Review this logic closely because an incorrect bound can duplicate uploads.",
      "files": [{ "label": "Bound transient retries", "file": "src/upload.ts" }]
    },
    {
      "name": "Expose the policy",
      "priority": "secondary",
      "description": "The public export makes the policy available to callers. It adds no retry behavior, so a compact review is sufficient.",
      "files": [{ "label": "Export retry policy", "file": "src/index.ts", "change": "changed" }]
    }
  ],
  "checks": { "automated": [], "manual": [] }
}
```

## Generated file exclusions

The target repository's current Git attributes define review visibility. `linguist-generated` (or a value other than `false`) excludes a file; `-linguist-generated`, `linguist-generated=false`, and unspecified attributes leave it visible. Git resolves nested rules and overrides. `.gitignore` and `linguist-vendored` do not exclude tracked review files.

Generated changes remain in `source.diff` and the sequential step patches for exact reconstruction and builds. They are omitted from rendered diffs, sidebar files, and diff statistics. Explicit references in `cases[].files`, `sections[].files[].file`, interface sources, callsites, or repository file links in Markdown are invalid. An all-generated patch uses an empty `cases`, `sections`, or `interfaces` array; visible changes still require complete structured coverage. Re-ingest after editing attributes to refresh the stored review.

## Patch rules

- Use Git unified patches, including `diff --git` headers. Preserve binary patch data when present.
- Each patch is relative to the cumulative state after prior patch-bearing steps, not necessarily directly to the base.
- Description and manual steps do not affect patch order.
- Every non-generated file in a test, implementation, or refactor diff must be covered by `cases[].files`, `sections[].files[].file`, or `interfaces[].file` plus `interfaces[].callsites[].file`, respectively. All references must occur in that step patch. Validation and ingestion fail with the missing paths if coverage is incomplete.
- Implementation sections partition the files exactly once. A file may serve multiple test areas or interfaces when relevant. For renames, reference the destination path; for deletions, reference the deleted path.
- It is acceptable for intermediate content to be absent from the final tree, but avoid invented churn that does not improve the explanation.
- Do not edit `source.diff` to make validation pass. Repair the step patches or narrative decomposition.
