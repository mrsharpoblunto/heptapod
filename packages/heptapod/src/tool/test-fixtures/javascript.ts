import { extname } from "node:path";
import { parseSync } from "@swc/core";
import type { ParsedTestCase, TestFixtureAdapter } from "./types.js";

type AstNode = Record<string, unknown>;

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function calleeRootName(value: unknown): string | null {
  if (!isAstNode(value)) return null;
  if (value.type === "Identifier" && typeof value.value === "string") return value.value;
  if (value.type === "MemberExpression") return calleeRootName(value.object);
  if (value.type === "CallExpression") return calleeRootName(value.callee);
  return null;
}

function literalTestName(argument: unknown): string | null {
  if (!isAstNode(argument) || !isAstNode(argument.expression)) return null;
  const expression = argument.expression;
  if (expression.type === "StringLiteral" && typeof expression.value === "string") {
    return expression.value;
  }
  if (expression.type === "TemplateLiteral" && Array.isArray(expression.expressions) && expression.expressions.length === 0) {
    const quasi = Array.isArray(expression.quasis) ? expression.quasis[0] : undefined;
    if (isAstNode(quasi) && isAstNode(quasi.cooked) && typeof quasi.cooked.value === "string") {
      return quasi.cooked.value;
    }
    if (isAstNode(quasi) && typeof quasi.raw === "string") return quasi.raw;
  }
  return null;
}

function normalizedAst(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedAst);
  if (!isAstNode(value)) return value;
  const keys = Object.keys(value);
  if (
    typeof value.start === "number"
    && typeof value.end === "number"
    && keys.every((key) => key === "start" || key === "end" || key === "ctxt")
  ) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "span" && key !== "ctxt")
      .map(([key, child]) => [key, normalizedAst(child)]),
  );
}

function collectTestCases(value: unknown, output: ParsedTestCase[], suites: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((child) => collectTestCases(child, output, suites));
    return;
  }
  if (!isAstNode(value)) return;
  if (value.type === "CallExpression") {
    const rootName = calleeRootName(value.callee);
    const argumentsList = Array.isArray(value.arguments) ? value.arguments : [];
    const name = literalTestName(argumentsList[0]);
    if (rootName === "describe" && name) {
      argumentsList.slice(1).forEach((child) => collectTestCases(child, output, [...suites, name]));
      return;
    }
    if ((rootName === "it" || rootName === "test") && name) {
      const position = isAstNode(value.span) && typeof value.span.start === "number" ? value.span.start : output.length;
      const endPosition = isAstNode(value.span) && typeof value.span.end === "number" ? value.span.end : position;
      output.push({
        key: [...suites, name].join("\u0000"),
        name,
        fingerprint: JSON.stringify(normalizedAst(value)),
        position,
        endPosition,
        line: 0,
        endLine: 0,
      });
      return;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "span") collectTestCases(child, output, suites);
  }
}

function parseJavaScriptTestCases(source: string, path: string): ParsedTestCase[] {
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) return [];
  const typescript = extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts";
  const jsx = extension === ".jsx" || extension === ".tsx";
  const program = parseSync(source, typescript
    ? { syntax: "typescript", tsx: jsx, decorators: true }
    : { syntax: "ecmascript", jsx, decorators: true });
  const cases: ParsedTestCase[] = [];
  collectTestCases(program, cases);
  const sourceBuffer = Buffer.from(source);
  const lineAt = (position: number) => sourceBuffer
    .subarray(0, Math.max(0, position - 1))
    .toString("utf8")
    .split("\n").length;
  return cases
    .sort((left, right) => left.position - right.position)
    .map((testCase) => ({
      ...testCase,
      line: lineAt(testCase.position),
      endLine: lineAt(Math.max(testCase.position, testCase.endPosition - 1)),
    }));
}

export const javascriptFixtures: TestFixtureAdapter = {
  supports: (path) => SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()),
  parse: parseJavaScriptTestCases,
};
