import type { EvidenceFixture } from "./test-evidence-requirements.js";
import { loadHeptapodConfig } from "./config.js";
import { analyzeTestFixture, type FixtureFormat } from "./test-fixtures/index.js";
import type { ParsedTestCase } from "./test-fixtures/types.js";

export { parseTestCases } from "./test-fixtures/index.js";
import { applyPatchToIndex, stagedTree, withTemporaryIndex } from "./git.js";
import { readArtifact, readStepMarkdown, resolveGeneratedFiles } from "./manifest.js";
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

function compareTestCases(before: ParsedTestCase[], after: ParsedTestCase[], moved = false): ParsedTestCaseChange[] {
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
      else if (oldCase && newCase && (moved || oldCase.fingerprint !== newCase.fingerprint)) {
        changes.push({
          name: newCase.name,
          change: oldCase.fingerprint !== newCase.fingerprint ? "changed" : "moved",
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
  renames: Map<string, string>,
): TestAreaChange[] {
  return (step.cases ?? []).map((area) => ({
    name: area.name,
    description: area.description,
    files: area.files.map((path) => {
      const beforePath = renames.get(path) ?? path;
      const before = analyzeTestFixture(readTreeFile(repo, beforeTree, beforePath) ?? "", beforePath, format);
      const after = analyzeTestFixture(readTreeFile(repo, afterTree, path) ?? "", path, format);
      return {
        path,
        isFixture: before.isFixture || after.isFixture,
        cases: compareTestCases(before.cases, after.cases, renames.has(path)),
      };
    }),
  }));
}

export interface NarrativeAnalysis {
  testFixturesByStep: Map<string, EvidenceFixture[]>;
  testAreasByStep: Map<string, TestAreaChange[]>;
  filesByStep: Map<string, Map<string, FileSnapshot>>;
  referenceFilesByStep: Map<string, Map<string, FileSnapshot>>;
}

export function analyzeNarrative(
  repo: string,
  manifest: NarrativeManifest,
  manifestPath: string,
  generated: ReadonlySet<string> = resolveGeneratedFiles(repo, manifest, manifestPath),
): NarrativeAnalysis {
  const format = loadHeptapodConfig(repo)?.test?.fixtures?.format ?? "auto";
  return withTemporaryIndex(repo, manifest.source.base, ({ env }) => {
    const watchedFixtures = new Set<string>();
    const testFixturesByStep = new Map<string, EvidenceFixture[]>();
    const testAreasByStep = new Map<string, TestAreaChange[]>();
    const filesByStep = new Map<string, Map<string, FileSnapshot>>();
    const referenceFilesByStep = new Map<string, Map<string, FileSnapshot>>();
    for (const [index, step] of manifest.steps.entries()) {
      const beforeTree = stagedTree(repo, env);
      const patch = step.diff ? readArtifact(manifestPath, step.diff) : null;
      if (patch) applyPatchToIndex(repo, env, patch, `${index + 1} (${step.id})`);
      const afterTree = stagedTree(repo, env);
      const patchFiles = patch ? splitPatchFiles(patch.toString("utf8")) : [];
      if (patch) {
        filesByStep.set(step.id, new Map(patchFiles.filter((file) => !generated.has(file.path)).map((file) => [
          file.path,
          {
            beforeContent: readTreeFile(repo, beforeTree, file.from ?? file.path),
            afterContent: readTreeFile(repo, afterTree, file.path),
          },
        ])));
      }
      const markdown = readStepMarkdown(step, manifestPath);
      if (markdown) {
        const references = new Map<string, FileSnapshot>();
        for (const path of extractRepositoryFileReferences(markdown)) {
          if (generated.has(path)) continue;
          const content = readTreeFile(repo, afterTree, path);
          if (content !== null) references.set(path, { beforeContent: content, afterContent: content });
        }
        if (references.size > 0) referenceFilesByStep.set(step.id, references);
      }
      for (const file of patchFiles) {
        if (file.from && watchedFixtures.delete(file.from)) watchedFixtures.add(file.path);
      }
      for (const area of step.cases ?? []) for (const file of area.files) {
        const content = readTreeFile(repo, afterTree, file) ?? readTreeFile(repo, beforeTree, file);
        if (content !== null && analyzeTestFixture(content, file, format).isFixture) watchedFixtures.add(file);
      }
      testFixturesByStep.set(step.id, [...watchedFixtures].map(file => {
        const content = readTreeFile(repo, afterTree, file);
        const current = content === null ? [] : analyzeTestFixture(content, file, format).cases;
        const before = readTreeFile(repo, beforeTree, patchFiles.find(patch => patch.path === file)?.from ?? file);
        const previous = before === null ? [] : analyzeTestFixture(before, file, format).cases;
        const remaining = new Map<string, number>();
        for (const test of current) remaining.set(test.key, (remaining.get(test.key) ?? 0) + 1);
        const removed = previous.filter(test => {
          const count = remaining.get(test.key) ?? 0;
          if (count) { remaining.set(test.key, count - 1); return false; }
          return true;
        }).map(test => ({ ...test, removed: true }));
        return { file, deleted: content === null, tests: [...current, ...removed] };
      }));
      if (patch && step.kind === "tests") {
        const renames = new Map(patchFiles.flatMap((file) => file.from ? [[file.path, file.from] as const] : []));
        testAreasByStep.set(step.id, analyzeTestStep(repo, step, beforeTree, afterTree, format, renames));
      }
    }
    return { testAreasByStep, filesByStep, referenceFilesByStep, testFixturesByStep };
  });
}
