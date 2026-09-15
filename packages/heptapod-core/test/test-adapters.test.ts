import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { loadHeptapodConfig } from "../src/tool/config.js";
import { analyzeTestFixture, parseTestCases } from "../src/tool/test-fixtures/index.js";
import { googletestRunner } from "../src/tool/test-runners/googletest.js";
import { vitestRunner } from "../src/tool/test-runners/vitest.js";

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

test("fixture adapters own recognition, including empty fixtures and supporting files", () => {
  assert.equal(analyzeTestFixture("// Empty test file", "empty.spec.ts", "javascript").isFixture, true);
  assert.equal(analyzeTestFixture("// Shared support", "support.spec.ts", "googletest").isFixture, false);
  assert.equal(analyzeTestFixture("TEST(Example, Works) {}", "declarations.txt", "googletest").isFixture, true);
  assert.equal(analyzeTestFixture("// Shared support", "support.h", "googletest").isFixture, false);
  assert.equal(analyzeTestFixture("// Unknown format", "empty.spec.txt").isFixture, false);
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
  assert.deepEqual(googletestRunner.parseResult(output).failures, ["Planet.Works"]);
  assert.equal(googletestRunner.parseResult(output).error, undefined);
  assert.match(googletestRunner.parseResult("[==========] Running 0 tests from 0 test suites.\n").error ?? "", /no tests/);
  assert.match(googletestRunner.parseResult("[ RUN      ] Planet.Works\n").error ?? "", /completed/);
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

test("Vitest interprets its failure sections and summaries, including recursive package output", () => {
  const output = [
    "stdout | arithmetic.test.ts > writes application logs",
    "FAIL this is an application log, not a reported test failure",
    "ERROR another application log",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
    " FAIL  arithmetic.test.ts > bounds > clamps values",
    "AssertionError: expected 5 to be 4",
    " Test Files  1 failed | 1 passed (2)",
    "      Tests  1 failed | 3 passed (4)",
  ].join("\n");
  const expected = { failures: ["arithmetic.test.ts > bounds > clamps values"] };
  assert.deepEqual(vitestRunner.parseResult(output), expected);
  assert.deepEqual(vitestRunner.parseResult(output.split("\n").map((line) => `packages/example test: ${line}`).join("\n")), expected);
  assert.deepEqual(vitestRunner.parseResult("FAIL an application message\nTest Files 1 passed (1)\nTests 3 passed (3)"), { failures: [] });
  assert.match(vitestRunner.parseResult("No test files found, exiting with code 0").error ?? "", /no tests/);
  assert.match(vitestRunner.parseResult("RUN v4.1.11\n").error ?? "", /completed/);
  assert.match(vitestRunner.parseResult("Test Files 1 failed (1)\nTests 1 failed (1)").error ?? "", /failing/);
  assert.match(vitestRunner.parseResult("Vitest caught 1 unhandled error during the test run.\nTest Files 1 passed (1)\nTests 1 passed (1)").error ?? "", /unhandled/);
});
