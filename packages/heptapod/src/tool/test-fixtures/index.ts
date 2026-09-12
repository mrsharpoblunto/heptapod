import { googletestFixtures } from "./googletest.js";
import { javascriptFixtures } from "./javascript.js";
import type { ParsedTestCase, TestFixtureAdapter } from "./types.js";

export const fixtureAdapters = {
  javascript: javascriptFixtures,
  googletest: googletestFixtures,
} satisfies Record<string, TestFixtureAdapter>;

export type FixtureFormat = "auto" | keyof typeof fixtureAdapters;

export function parseTestCases(source: string, path: string, format: FixtureFormat = "auto"): ParsedTestCase[] {
  return analyzeTestFixture(source, path, format).cases;
}

export function analyzeTestFixture(source: string, path: string, format: FixtureFormat = "auto"): { cases: ParsedTestCase[]; isFixture: boolean } {
  const adapter = format === "auto"
    ? Object.values(fixtureAdapters).find((candidate) => candidate.supports(path))
    : fixtureAdapters[format];
  const cases = adapter?.parse(source, path) ?? [];
  return { cases, isFixture: adapter?.isFixture(path, cases) ?? false };
}
