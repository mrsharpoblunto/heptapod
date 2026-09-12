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
        "detail": "Ran against the reconstructed state after this step."
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

The `cases` entries describe broad test areas, not individual `it()`/`test()` names. Explain the functionality and risk covered without restating the literal cases; Heptapod parses those names and their added/removed/changed status from the before/after source using SWC. Each area must link to at least one file changed by the step patch:

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

Describe the changed interface separately from every updated callsite. File references must be paths in this step's patch.

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

`before`, `after`, and interface `file` are optional. `before` and `after` contain Markdown: use normal prose, inline code, fenced code with an explicit language, or both. Do not assume the viewer treats the whole value as source code. Use `file` as the source only when a specific API or implementation file triggers that section's caller migrations. Omit it for a distributed set of small migrations with no single source; the viewer then omits the Source group. `interfaces` must be non-empty, every interface requires a `callsites` array, and the step must contain at least one callsite across its interface sections. Step-level `callsites` are invalid. `callsites[].change` is optional and may be `added`, `removed`, or `changed`; when omitted, Heptapod infers it from whether the containing file was added, deleted, or modified.

## Implementation steps

`focus` names one or more files whose diffs appear in the main column. Every focused file must be changed by the step patch. Other changed files remain accessible in the detail column.

```json
{
  "id": "implement-retries",
  "title": "Retry transient failures with a fixed bound",
  "kind": "implementation",
  "body": "steps/03-implementation.md",
  "diff": "diffs/03-implementation.diff",
  "focus": ["src/upload.ts"],
  "checks": { "automated": [], "manual": [] }
}
```

## Patch rules

- Use Git unified patches, including `diff --git` headers. Preserve binary patch data when present.
- Each patch is relative to the cumulative state after prior patch-bearing steps, not necessarily directly to the base.
- Description and manual steps do not affect patch order.
- A path referenced by `focus`, `cases[].files`, `interfaces[].file`, or `callsites[].file` must occur in that step patch.
- It is acceptable for intermediate content to be absent from the final tree, but avoid invented churn that does not improve the explanation.
- Do not edit `source.diff` to make validation pass. Repair the step patches or narrative decomposition.
