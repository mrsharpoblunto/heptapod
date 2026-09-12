import { extname } from "node:path";
import type { ParsedTestCase, TestFixtureAdapter } from "./types.js";

interface Token {
  value: string;
  start: number;
  end: number;
}

// Keep literals intact for comparisons, but never interpret their contents as C++.
function tokens(source: string): Token[] {
  const pattern = /(?:^[\t ]*#(?:\\\r?\n|[^\n])*)|(?:\/\/(?:\\\r?\n|[^\n])*)|(?:\/\*[\s\S]*?\*\/)|(?:\b(?:u8|u|U|L)?R"([^\s()\\]{0,16})\([\s\S]*?\)\1")|(?:\b(?:u8|u|U|L))?"(?:\\[\s\S]|[^"\\])*"|(?:\b(?:u8|u|U|L))?'(?:\\[\s\S]|[^'\\])*'|(?:[A-Za-z_][\w]*)|(?:\d[\w.']*)|(?:[^\s])/gm;
  return [...source.matchAll(pattern)]
    .filter(([value]) => !value.startsWith("//") && !value.startsWith("/*"))
    .map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

const MACROS = new Set(["TEST", "TEST_F", "TEST_P", "TYPED_TEST", "TYPED_TEST_P"]);
const EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]);

function selectors(macro: string, suite: string, name: string): string[] {
  if (macro === "TEST_P") return [`*/${suite}.${name}/*`];
  if (macro === "TYPED_TEST") return [`${suite}/*.${name}`];
  if (macro === "TYPED_TEST_P") return [`*/${suite}/*.${name}`];
  return [`${suite}.${name}`];
}

export const googletestFixtures: TestFixtureAdapter = {
  supports: (path) => EXTENSIONS.has(extname(path).toLowerCase()),
  isFixture: (_path, cases) => cases.length > 0,
  parse(source) {
    const parsed: ParsedTestCase[] = [];
    const input = tokens(source);
    const lineAt = (position: number) => source.slice(0, position).split("\n").length;
    for (let index = 0; index < input.length; index += 1) {
      const macro = input[index];
      if (!MACROS.has(macro.value)) continue;
      const suite = input[index + 2]?.value;
      const name = input[index + 4]?.value;
      if (input[index + 1]?.value !== "(" || input[index + 3]?.value !== ","
        || input[index + 5]?.value !== ")" || input[index + 6]?.value !== "{"
        || !suite?.match(/^[A-Za-z_]\w*$/) || !name?.match(/^[A-Za-z_]\w*$/)) continue;
      let end = index + 7;
      let depth = 1;
      while (end < input.length && depth > 0) {
        if (input[end].value === "{") depth += 1;
        if (input[end].value === "}") depth -= 1;
        end += 1;
      }
      if (depth !== 0) continue;
      const last = input[end - 1];
      parsed.push({
        key: `${suite}.${name}`,
        name: `${suite}.${name}`,
        fingerprint: JSON.stringify(input.slice(index, end).map(({ value }) => value)),
        position: macro.start,
        endPosition: last.end,
        line: lineAt(macro.start),
        endLine: lineAt(last.end - 1),
        selectors: selectors(macro.value, suite, name),
      });
      index = end - 1;
    }
    return parsed;
  },
};
