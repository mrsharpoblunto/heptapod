import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { loadHeptapodConfig } from "../src/tool/config.js";
import { analyzeNarrative } from "../src/tool/test-analysis.js";
import { executeNarrativeTests } from "../src/tool/test-execution.js";
import { parseTestCases } from "../src/tool/test-fixtures/index.js";
import { googletestRunner } from "../src/tool/test-runners/googletest.js";
import type { NarrativeManifest } from "../src/tool/types.js";

const temporaryDirectories: string[] = [];
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-adapters-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("fixture formats are independent and auto detection keeps JavaScript support", () => {
  assert.equal(parseTestCases("it('works', () => true)", "test.ts")[0].name, "works");
  assert.deepEqual(parseTestCases("TEST(Suite, Works) {}", "test.cpp", "javascript"), []);
  assert.equal(parseTestCases("TEST(Suite, Works) {}", "fixture.txt", "googletest")[0].name, "Suite.Works");
});

test("GoogleTest fixtures parse standard macros, nested bodies, comments and literal contents", () => {
  const source = [
    '// TEST(Fake, Comment) {}',
    '#define DECLARE_TEST TEST(Fake, Macro) {}',
    'const char* text = "TEST(Fake, String) { }";',
    'TEST_F(Planet, KeepsContact) {',
    '  const char* text = R"tag({ TEST(Fake, Raw) {} })tag";',
    '  if (ready) { EXPECT_EQ(3, value); }',
    '}',
    'TEST_P(Planet, SupportsSeeds) {}',
    'TYPED_TEST(Storage, HoldsValues) {}',
    'TYPED_TEST_P(Storage, HoldsTypes) {}',
  ].join("\n");
  const cases = parseTestCases(source, "PlanetTests.cpp");
  assert.deepEqual(cases.map(({ name, line, endLine }) => ({ name, line, endLine })), [
    { name: "Planet.KeepsContact", line: 4, endLine: 7 },
    { name: "Planet.SupportsSeeds", line: 8, endLine: 8 },
    { name: "Storage.HoldsValues", line: 9, endLine: 9 },
    { name: "Storage.HoldsTypes", line: 10, endLine: 10 },
  ]);
  assert.deepEqual(cases.flatMap(({ selectors }) => selectors), [
    "Planet.KeepsContact", "*/Planet.SupportsSeeds/*", "Storage/*.HoldsValues", "*/Storage/*.HoldsTypes",
  ]);
  assert.equal(cases[0].fingerprint, parseTestCases(source.replace("EXPECT_EQ(3, value)", "EXPECT_EQ( 3, /* comment */ value )"), "a.cpp")[0].fingerprint);
  assert.notEqual(cases[0].fingerprint, parseTestCases(source.replace("EXPECT_EQ(3, value)", "EXPECT_EQ(4, value)"), "a.cpp")[0].fingerprint);
  const directives = '#define IGNORE \\\nTEST(Fake, ContinuedMacro) {}\n// Ignore this too \\\nTEST(Fake, ContinuedComment) {}\nTEST(Real, Body) {\n#define VALUE 1\nEXPECT_EQ(VALUE, value);\n}\n';
  const directiveCases = parseTestCases(directives, "a.cpp");
  assert.deepEqual(directiveCases.map(({ name }) => name), ["Real.Body"]);
  assert.notEqual(directiveCases[0].fingerprint, parseTestCases(directives.replace("VALUE 1", "VALUE 2"), "a.cpp")[0].fingerprint);
});

test("GoogleTest targeting uses registered-name filters, never file arguments", () => {
  const repo = temporaryDirectory();
  writeFileSync(join(repo, "test.cpp"), "TEST_F(Planet, Works) {}\nTEST_P(Planet, Seeds) {}\n");
  assert.deepEqual(googletestRunner.target(repo, ["bin/tests", "--custom"], "test.cpp", "auto").command?.args,
    ["--custom", "--gtest_color=no", "--gtest_filter=Planet.Works:*/Planet.Seeds/*"]);
  assert.equal(googletestRunner.target(repo, ["bin/tests"], "test.cpp", "javascript").command, null);
  assert.ok(googletestRunner.fullCommand(["bin/tests"]).args.includes("--gtest_filter=*"));
});

test("GoogleTest failures exclude summary counts and require a completed nonempty run", () => {
  const output = "[ RUN      ] Planet.Works\n[  FAILED  ] Planet.Works (2 ms)\n[==========] 1 test from 1 test suite ran. (2 ms total)\n[  FAILED  ] 1 test, listed below:\n[  FAILED  ] Planet.Works\n";
  assert.deepEqual(googletestRunner.failures(output), ["Planet.Works"]);
  assert.equal(googletestRunner.resultError?.(output), undefined);
  assert.match(googletestRunner.resultError?.("[==========] Running 0 tests from 0 test suites.\n") ?? "", /no tests/);
  assert.match(googletestRunner.resultError?.("[ RUN      ] Planet.Works\n") ?? "", /completed/);
});

test("configuration rejects invalid formats and conflicting GoogleTest filters", () => {
  const repo = temporaryDirectory();
  for (const config of [
    [], { test: [] }, { test: { runner: { format: "unknown", command: ["test"] } } },
    { test: { runner: { format: ["command"], command: ["test"] } } },
    { test: { fixtures: { format: "unknown" } } }, { test: { fixtures: null } },
    { test: { build: { command: ["build"] } } }, { test: { worktreeDirectory: "" } },
    { test: { runner: { format: "googletest", command: ["test", "{files}"] } } },
    { test: { runner: { format: "googletest", command: ["test", "--gtest_filter=Foo.*"] } } },
  ]) {
    writeFileSync(join(repo, ".heptapod.json"), JSON.stringify(config));
    assert.throws(() => loadHeptapodConfig(repo), /Invalid .heptapod.json/);
  }
});

function googleTestRepository() {
  const repo = temporaryDirectory();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "state.txt"), "red");
  writeFileSync(join(repo, "test.cpp"), "TEST(Planet, Legacy) {}\n");
  writeFileSync(join(repo, "build.mjs"), `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    const state = readFileSync('state.txt', 'utf8');
    appendFileSync(process.env.HEPTAPOD_REPOSITORY + '/build-log', state + '\\n');
    if (state === 'broken') process.exit(2);
    writeFileSync('built-state', state);
  `);
  writeFileSync(join(repo, "test.mjs"), `
    import { appendFileSync, readFileSync } from 'node:fs';
    const filter = process.argv.find(arg => arg.startsWith('--gtest_filter='));
    appendFileSync(process.env.HEPTAPOD_REPOSITORY + '/run-log', filter + '\\n');
    if (readFileSync('built-state', 'utf8') !== readFileSync('state.txt', 'utf8')) throw new Error('Stale build');
    const failed = readFileSync('built-state', 'utf8') !== 'green';
    console.log('[==========] Running 1 test from 1 test suite.');
    console.log('[ RUN      ] Planet.Works');
    console.log(failed ? '[  FAILED  ] Planet.Works (1 ms)' : '[       OK ] Planet.Works (1 ms)');
    console.log('[==========] 1 test from 1 test suite ran. (1 ms total)');
    process.exit(failed ? 1 : 0);
  `);
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "test.cpp"), "TEST(Planet, Works) { EXPECT_TRUE(works()); }\n");
  writeFileSync(join(repo, "test-support.h"), "// Shared test setup\n");
  git("add", "."); git("commit", "-qm", "test");
  const middle = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "state.txt"), "green");
  git("add", "."); git("commit", "-qm", "fix");
  const head = git("rev-parse", "HEAD");
  const config = {
    test: {
      fixtures: { format: "googletest" },
      runner: { format: "googletest", command: [process.execPath, "test.mjs"] },
      build: [{ command: [process.execPath, "build.mjs"] }],
      worktreeDirectory: "worktrees",
    },
  };
  writeFileSync(join(repo, ".heptapod.json"), JSON.stringify(config));
  writeFileSync(join(repo, "tests.diff"), git("diff", "--binary", base, middle) + "\n");
  writeFileSync(join(repo, "fix.diff"), git("diff", "--binary", middle, head) + "\n");
  const manifest: NarrativeManifest = {
    schemaVersion: 1, title: "Fix planet behavior", summary: "Test the native runner", source: { base, head, diff: "source.diff" },
    steps: [
      { id: "tests", title: "Specify behavior", kind: "tests", diff: "tests.diff",
        cases: [{ name: "Planet behavior", description: "Keeps planets stable", files: ["test.cpp", "test-support.h"] }],
        checks: { automated: [{ label: "Planet.Works", basis: "expected", status: "failing" }], manual: [] } },
      { id: "fix", title: "Fix behavior", kind: "implementation", diff: "fix.diff",
        checks: { automated: [{ label: "Planet.Works", basis: "expected", status: "passing" }], manual: [] } },
    ],
  };
  return { repo, git, manifest, config, manifestPath: join(repo, "narrative.json") };
}

test("native execution rebuilds each patched state, filters changed fixtures and runs the final suite", () => {
  const { repo, git, manifest, manifestPath } = googleTestRepository();
  const before = git("worktree", "list", "--porcelain");
  const analysis = analyzeNarrative(repo, manifest, manifestPath);
  assert.deepEqual(analysis.testAreasByStep.get("tests")?.[0].files[0].cases.map(({ name, change }) => ({ name, change })), [
    { name: "Planet.Legacy", change: "removed" }, { name: "Planet.Works", change: "added" },
  ]);
  assert.equal(analysis.testAreasByStep.get("tests")?.[0].files[1].isFixture, false);
  const execution = executeNarrativeTests(repo, manifest, manifestPath, () => {}, analysis.testAreasByStep);
  assert.deepEqual(execution.runsByStep.get("tests")?.files, ["test.cpp"]);
  assert.equal(execution.runsByStep.get("tests")?.status, "failing");
  assert.deepEqual(execution.runsByStep.get("tests")?.observedFailures, ["Planet.Works"]);
  assert.equal(execution.runsByStep.get("fix")?.status, "passing");
  assert.equal(execution.runsByStep.get("fix")?.expectationMatched, true);
  assert.equal(execution.runsByStep.get("fix")?.scope, "full-suite");
  assert.equal(readFileSync(join(repo, "build-log"), "utf8"), "red\ngreen\n");
  assert.equal(readFileSync(join(repo, "run-log"), "utf8"), "--gtest_filter=Planet.Works\n--gtest_filter=Planet.Works\n--gtest_filter=*\n");
  assert.equal(git("worktree", "list", "--porcelain"), before);
  assert.deepEqual(readdirSync(join(repo, "worktrees")), []);
});

test("failed builds prevent stale binaries from running and later steps can recover", () => {
  const { repo, manifest, manifestPath, config } = googleTestRepository();
  config.test.build = [{ command: [process.execPath, "-e", "const fs=require('node:fs'); if(fs.readFileSync('state.txt','utf8')==='red')process.exit(2);fs.writeFileSync('built-state','green');"] }];
  writeFileSync(join(repo, ".heptapod.json"), JSON.stringify(config));
  const analysis = analyzeNarrative(repo, manifest, manifestPath);
  assert.equal(analysis.testAreasByStep.get("tests")?.[0].files[1].isFixture, false);
  const execution = executeNarrativeTests(repo, manifest, manifestPath, () => {}, analysis.testAreasByStep);
  assert.deepEqual(execution.runsByStep.get("tests")?.files, ["test.cpp"]);
  assert.equal(execution.runsByStep.get("tests")?.status, "failing");
  assert.match(execution.runsByStep.get("tests")?.detail ?? "", /Build failed/);
  assert.equal(execution.runsByStep.get("tests")?.fixtureRuns[0].status, "not-run");
  assert.equal(execution.runsByStep.get("fix")?.status, "passing");
  assert.equal(readFileSync(join(repo, "run-log"), "utf8"), "--gtest_filter=Planet.Works\n--gtest_filter=*\n");
});
