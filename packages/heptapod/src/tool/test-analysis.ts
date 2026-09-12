import { extname } from "node:path";
import { parseSync } from "@swc/core";
import { applyPatchToIndex, stagedTree, withTemporaryIndex } from "./git.js";
import { readArtifact } from "./manifest.js";
import { extractRepositoryFileReferences } from "./markdown-references.js";
import { splitPatchFiles } from "./patch.js";
import { run } from "./process.js";
import type {
  NarrativeManifest,
  NarrativeStep,
  ParsedTestCaseChange,
  FileSnapshot,
  TestAreaChange,
} from "./types.js";

interface ParsedTestCase {
  key: string;
  name: string;
  fingerprint: string;
  position: number;
  endPosition: number;
  line: number;
  endLine: number;
}

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

export function parseTestCases(source: string, path: string): ParsedTestCase[] {
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

function readTreeFile(repo: string, tree: string, path: string): string | null {
  const result = run("git", ["show", `${tree}:${path}`], { cwd: repo, allowFailure: true });
  if (result.status !== 0 || result.stdout.includes(0)) return null;
  return result.stdout.toString("utf8");
}

function compareTestCases(before: ParsedTestCase[], after: ParsedTestCase[]): ParsedTestCaseChange[] {
  const beforeByName = new Map<string, ParsedTestCase[]>();
  const afterByName = new Map<string, ParsedTestCase[]>();
  for (const item of before) beforeByName.set(item.key, [...(beforeByName.get(item.key) ?? []), item]);
  for (const item of after) afterByName.set(item.key, [...(afterByName.get(item.key) ?? []), item]);

  const changes: Array<ParsedTestCaseChange & { position: number }> = [];
  const names = new Set([...beforeByName.keys(), ...afterByName.keys()]);
  for (const key of names) {
    const oldCases = beforeByName.get(key) ?? [];
    const newCases = afterByName.get(key) ?? [];
    const count = Math.max(oldCases.length, newCases.length);
    for (let index = 0; index < count; index += 1) {
      const oldCase = oldCases[index];
      const newCase = newCases[index];
      if (!oldCase && newCase) changes.push({ name: newCase.name, change: "added", newLine: newCase.line, newEndLine: newCase.endLine, position: newCase.position });
      else if (oldCase && !newCase) changes.push({ name: oldCase.name, change: "removed", oldLine: oldCase.line, oldEndLine: oldCase.endLine, position: oldCase.position });
      else if (oldCase && newCase && oldCase.fingerprint !== newCase.fingerprint) {
        changes.push({
          name: newCase.name,
          change: "changed",
          oldLine: oldCase.line,
          oldEndLine: oldCase.endLine,
          newLine: newCase.line,
          newEndLine: newCase.endLine,
          position: newCase.position,
        });
      }
    }
  }
  return changes
    .sort((left, right) => left.position - right.position)
    .map(({ name, change, oldLine, oldEndLine, newLine, newEndLine }) => ({
      name,
      change,
      oldLine,
      oldEndLine,
      newLine,
      newEndLine,
    }));
}

function analyzeTestStep(
  repo: string,
  step: NarrativeStep,
  beforeTree: string,
  afterTree: string,
): TestAreaChange[] {
  return (step.cases ?? []).map((area) => ({
    name: area.name,
    description: area.description,
    files: area.files.map((path) => ({
      path,
      cases: compareTestCases(
        parseTestCases(readTreeFile(repo, beforeTree, path) ?? "", path),
        parseTestCases(readTreeFile(repo, afterTree, path) ?? "", path),
      ),
    })),
  }));
}

export interface NarrativeAnalysis {
  testAreasByStep: Map<string, TestAreaChange[]>;
  filesByStep: Map<string, Map<string, FileSnapshot>>;
  referenceFilesByStep: Map<string, Map<string, FileSnapshot>>;
}

export function analyzeNarrative(
  repo: string,
  manifest: NarrativeManifest,
  manifestPath: string,
): NarrativeAnalysis {
  return withTemporaryIndex(repo, manifest.source.base, ({ env }) => {
    const testAreasByStep = new Map<string, TestAreaChange[]>();
    const filesByStep = new Map<string, Map<string, FileSnapshot>>();
    const referenceFilesByStep = new Map<string, Map<string, FileSnapshot>>();
    for (const [index, step] of manifest.steps.entries()) {
      const beforeTree = stagedTree(repo, env);
      const patch = step.diff ? readArtifact(manifestPath, step.diff) : null;
      if (patch) applyPatchToIndex(repo, env, patch, `${index + 1} (${step.id})`);
      const afterTree = stagedTree(repo, env);
      if (patch) {
        filesByStep.set(step.id, new Map(splitPatchFiles(patch.toString("utf8")).map((file) => [
          file.path,
          {
            beforeContent: readTreeFile(repo, beforeTree, file.path),
            afterContent: readTreeFile(repo, afterTree, file.path),
          },
        ])));
      }
      if (step.body) {
        const markdown = readArtifact(manifestPath, step.body).toString("utf8");
        const references = new Map<string, FileSnapshot>();
        for (const path of extractRepositoryFileReferences(markdown)) {
          const content = readTreeFile(repo, afterTree, path);
          if (content !== null) references.set(path, { beforeContent: content, afterContent: content });
        }
        if (references.size > 0) referenceFilesByStep.set(step.id, references);
      }
      if (patch && step.kind === "tests") {
        testAreasByStep.set(step.id, analyzeTestStep(repo, step, beforeTree, afterTree));
      }
    }
    return { testAreasByStep, filesByStep, referenceFilesByStep };
  });
}
