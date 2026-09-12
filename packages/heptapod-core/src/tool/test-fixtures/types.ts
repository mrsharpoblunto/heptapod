export interface ParsedTestCase {
  key: string;
  name: string;
  fingerprint: string;
  position: number;
  endPosition: number;
  line: number;
  endLine: number;
  selectors?: string[];
}

export interface TestFixtureAdapter {
  supports(path: string): boolean;
  parse(source: string, path: string): ParsedTestCase[];
  isFixture(path: string, cases: ParsedTestCase[]): boolean;
}
