import { googletestFixtures } from "./googletest.js";
import { javascriptFixtures } from "./javascript.js";
import type { ParsedTestCase, TestFixtureAdapter } from "./types.js";

export const fixtureAdapters = {
  javascript: javascriptFixtures,
  googletest: googletestFixtures,
} satisfies Record<string, TestFixtureAdapter>;

export type FixtureFormat = "auto" | keyof typeof fixtureAdapters;

export function parseTestCases(source: string, path: string, format: FixtureFormat = "auto"): ParsedTestCase[] {
  const adapter = format === "auto"
    ? Object.values(fixtureAdapters).find((candidate) => candidate.supports(path))
    : fixtureAdapters[format];
  return adapter?.parse(source, path) ?? [];
}
