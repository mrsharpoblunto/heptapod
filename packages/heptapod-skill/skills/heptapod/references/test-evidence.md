# Required test evidence

The calling agent runs tests. `ingest` never executes recorded commands. It requires `test-results.json` with `schemaVersion: 2`, original runner reports, and logs beside `narrative.json`. Version 1 evidence is rejected because it does not account for individual metadata entries.

Run `heptapod validate --id <review-id> --output ndjson` before execution. The result includes `stepTrees` and `testRequirements`, keyed by step ID. Use the returned targets verbatim. Ingestion independently reconstructs the same requirements; the agent cannot reduce them by omitting entries from its result file.

Each step needs exactly one result and exactly one `coverage` entry per required target:

- `automated/<index>`: every entry in that step's `checks.automated`, including checks marked not applicable.
- `area/<index>`: every test area in `cases`, covering its runnable fixtures. Helpers/setup files do not become runnable tests.
- `fixture/<encoded-path>`: each fixture introduced in test metadata, carried through subsequent steps and renames.
- `test/<encoded-path>/<index>`: each statically identified declaration in those fixtures at that step. Duplicate names remain distinct occurrences. Removed declarations require an explicit non-execution result; newly added declarations require new evidence.

Indexes are zero-based. Re-run validation after editing metadata or patches; both targets and trees can change. A step-level pass is insufficient to satisfy any of these targets.

## Result file

Example for a step with one automated check and one fixture containing one test:

```json
{
  "schemaVersion": 2,
  "base": "<full pinned base SHA>",
  "head": "<full pinned head SHA>",
  "timeoutMs": 900000,
  "results": [
    {
      "stepId": "behavior",
      "tree": "<verified tested tree>",
      "scope": "full-suite",
      "files": ["test/behavior.test.ts"],
      "status": "passing",
      "command": "pnpm vitest run --reporter=json --outputFile=report.json",
      "exitCode": 0,
      "durationMs": 1432,
      "failures": [],
      "log": "logs/behavior.txt",
      "reports": [
        {
          "id": "unit",
          "format": "vitest",
          "path": "reports/behavior.json",
          "root": "/absolute/path/to/test-worktree",
          "command": "pnpm vitest run --reporter=json --outputFile=report.json",
          "exitCode": 0,
          "log": "logs/behavior.txt"
        }
      ],
      "coverage": [
        { "target": "automated/0", "status": "passing", "results": [{ "report": "unit", "tests": [0] }] },
        { "target": "area/0", "status": "passing", "results": [{ "report": "unit", "tests": [0] }] },
        { "target": "fixture/test%2Fbehavior.test.ts", "status": "passing", "results": [{ "report": "unit", "tests": [0] }] },
        { "target": "test/test%2Fbehavior.test.ts/0", "status": "passing", "results": [{ "report": "unit", "tests": [0] }] }
      ]
    }
  ]
}
```

Every narrative step needs a result, including the initial description step. The final step requires `full-suite`; intermediate steps use `changed-tests`, or `full-suite` when focused execution is unavailable. Keep the complete suite report, including tests unrelated to the edited metadata, so unrelated failures cannot disappear from the aggregate result.

Executed step results require a command, log, duration, exit code, and at least one report. The aggregate `command` is the distinct report commands in report order joined by ` && `. `files` must include every required fixture and may include other files present in the reports; unrelated file claims are rejected. Keep a separate report artifact for each tested tree; reusing one artifact across different trees is rejected. Paths to logs and reports are relative to the metadata directory and cannot escape it, including via symlinks. Preserve original artifacts; ingestion stores only the final 200,000 characters of displayed logs. Durations are nonnegative milliseconds. Set a positive `timeoutMs` to the limit used for execution.

Step statuses are `passing`, `failing`, `timed-out`, and `not-run`. Ingestion derives aggregate status from all reports and rejects a contradictory claim. `passing` requires exit zero and no failures. A timed-out process uses null exit code. `failures` must include exactly the report-derived failures: native test failures are named `<repository-relative file> > <full test name>`; suite errors are also reported. A command failure without named failures is `<command>: exited with <code>` (or `no exit code`); a timeout is `<command>: timed out`. Do not suppress an unrelated failure because a failing test was expected.

## Runner reports and coverage references

Supported report formats:

- `vitest`: the original JSON reporter output. Generate it with `--reporter=json --outputFile=<path>` (retain a console reporter too if desired). Ingestion reads assertions and validates summary counts, failure messages, and success flags. Test indexes flatten `testResults[].assertionResults[]` in report order.
- `googletest`: the original JSON report from `--gtest_output=json:<path>`. Ingestion reads each test's file, suite/name, execution status, failures, and duration, and validates summary counts. Indexes flatten `testsuites[].testsuite[]` in report order. Parameterized and typed test selectors match all reported instances of a declaration.
- `command`: a process receipt for command-level checks such as lint/build/typechecking. It can **only** back an `automated` check, never a test area, fixture, or individual test declaration. See the receipt format below.

For native reports, `root` is the absolute original checkout path used to interpret file paths in the report. Keep the raw report unchanged when copying it out of the worktree. Relative report file names must be relative to that root. If a runner reports package-relative paths, configure it to report absolute paths or generate reports from the repository root.

A coverage reference selects `{ "report": "unit", "tests": [0, 2] }`; omit `tests` only when the entire report applies to that entry. A report may support multiple metadata entries (for example an area, fixture, and check). Test targets must match the source-derived file and qualified name/selector. Fixture and area selections must include every reported outcome for their files; selectively omitting a failure is rejected. Duplicate source names need separate reporter occurrences. Metadata checks with a `command` must reference evidence using that exact command.

Coverage status is computed from the selected outcomes. Any failing or timed-out outcome prevents a pass, and skipped outcomes are represented as `not-run`, never converted into passing. Explain skipped/incomplete results in `detail`. Ingestion stores these per-entry results and computes expectation mismatches; authored expectations do not overwrite observed outcomes. Do not submit the old `fixtures` array: fixture results now come from validated coverage and reports.

## Blockers and non-applicable entries

If execution cannot happen, account for **each** required entry:

```json
{
  "target": "test/test%2Fbehavior.test.ts/0",
  "status": "not-run",
  "results": [],
  "detail": "Dependency installation failed before tests could start; see logs/install.txt."
}
```

The enclosing step uses `status: not-run`, null command/exit code, a nonempty reason, empty `reports`/`failures`, and may attach the failed setup/build log. Missing evidence is not silently converted to `not-run`. If a report already contains an outcome for the target, reference that outcome instead of claiming there is no result.

Use `not-applicable` with a nonempty reason only when `testRequirements` explicitly permits it: a metadata check marked not applicable, a deleted fixture/declaration, or an area containing only supporting files. An empty or incomplete reporter file cannot establish a pass. For an unsupported runner, add a native report adapter or explicitly report the unavailable individual results as not run; do not substitute a successful process exit for named test evidence.

## Command receipt

Record this from the process execution (do not infer it from a narrative expectation):

```json
{
  "command": "pnpm typecheck",
  "exitCode": 0,
  "durationMs": 823,
  "timedOut": false,
  "output": "<exact combined process output>"
}
```

Attach it through a report with `format: command`; the report's command and exit code must match the receipt, and its log must exactly match `output`. Command receipts also record timeouts and signal failures. They do not contain or prove individual test results.

## Execution responsibilities

Create an isolated test worktree at the pinned base, respecting `.heptapod.json`'s `worktreeDirectory`. Apply patches in order with `git apply --index --binary --whitespace=nowarn --recount <absolute-patch-path>`. Compare `git write-tree` to that step's `stepTrees` entry and ensure no unstaged tracked modifications precede each run. Never copy a tree ID from validation without checking the tested checkout.

Run configured prerequisites/builds before tests, refresh dependencies as needed, honor batching/rebuild policy, and do not execute stale binaries after a failed build. Set `HEPTAPOD_REPOSITORY` and `HEPTAPOD_WORKTREE` for setup that uses them. `{files}` expands to selected fixtures for command/Vitest runners and is removed for full-suite execution. GoogleTest uses fixture-derived filters and `--gtest_filter=*` for the final suite. Restore tracked files modified by tests before the next patch, preserve all reports/logs outside the worktree, and clean up only the worktree you created.

This validates coverage and consistency against submitted runner data; it cannot authenticate that the agent actually executed a command or prove an arbitrary command selected the entire repository suite. Manual checks remain separate reviewer procedures/evidence and must not be represented as automated passes.

Native format references: [Vitest JSON reporter](https://vitest.dev/guide/reporters#json-reporter) and [GoogleTest JSON output](https://google.github.io/googletest/advanced.html#generating-a-json-report).
