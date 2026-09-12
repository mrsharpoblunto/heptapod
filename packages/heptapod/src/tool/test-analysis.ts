import { loadHeptapodConfig } from "./config.js";
import { parseTestCases, type FixtureFormat } from "./test-fixtures/index.js";
import type { ParsedTestCase } from "./test-fixtures/types.js";

export { parseTestCases } from "./test-fixtures/index.js";
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
  format: FixtureFormat,
): TestAreaChange[] {
  return (step.cases ?? []).map((area) => ({
    name: area.name,
    description: area.description,
    files: area.files.map((path) => {
      const before = parseTestCases(readTreeFile(repo, beforeTree, path) ?? "", path, format);
      const after = parseTestCases(readTreeFile(repo, afterTree, path) ?? "", path, format);
      return {
        path,
        isFixture: before.length > 0 || after.length > 0 || /(?:^|[./-])(?:test|spec)\.[cm]?[jt]sx?$/i.test(path),
        cases: compareTestCases(before, after),
      };
    }),
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
  const format = loadHeptapodConfig(repo)?.test?.fixtures?.format ?? "auto";
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
      const markdown = [
        step.body ? readArtifact(manifestPath, step.body).toString("utf8") : "",
        ...(step.sections ?? []).map((section) => section.description),
      ].join("\n\n");
      if (markdown) {
        const references = new Map<string, FileSnapshot>();
        for (const path of extractRepositoryFileReferences(markdown)) {
          const content = readTreeFile(repo, afterTree, path);
          if (content !== null) references.set(path, { beforeContent: content, afterContent: content });
        }
        if (references.size > 0) referenceFilesByStep.set(step.id, references);
      }
      if (patch && step.kind === "tests") {
        testAreasByStep.set(step.id, analyzeTestStep(repo, step, beforeTree, afterTree, format));
      }
    }
    return { testAreasByStep, filesByStep, referenceFilesByStep };
  });
}
