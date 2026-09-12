import { readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { assertStepFileCoverage } from "./file-coverage.js";
import { patchStats, splitPatchFiles } from "./patch.js";
import { rewriteRepositoryFileLinks } from "./markdown-references.js";
import { readArtifact, resolveArtifactPath } from "./manifest.js";
import type {
  Callsite,
  NarrativeManifest,
  RenderModel,
  VerificationResult,
  Evidence,
  FileSnapshot,
  TestAreaChange,
} from "./types.js";
import type { NarrativeTestExecution } from "./test-execution.js";

const MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function inlineMarkdownImages(markdown: string, bodyPath: string, manifestPath: string): string {
  const artifactRoot = dirname(resolve(manifestPath));
  const bodyDirectory = dirname(resolveArtifactPath(manifestPath, bodyPath, bodyPath));
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (match, alt: string, source: string) => {
    if (/^(?:data:|https?:)/i.test(source)) return match;
    const imagePath = resolve(bodyDirectory, decodeURIComponent(source));
    const traversal = relative(artifactRoot, imagePath);
    if (traversal === ".." || traversal.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`Markdown image leaves the artifact directory: ${source}`);
    }
    const mime = MIME_TYPES.get(extname(imagePath).toLowerCase());
    if (!mime) throw new Error(`Unsupported local Markdown image type: ${source}`);
    const data = readFileSync(imagePath).toString("base64");
    return `![${alt}](data:${mime};base64,${data})`;
  });
}

export function buildReviewModel(
  manifest: NarrativeManifest,
  manifestPath: string,
  verification: VerificationResult,
  testAreasByStep: Map<string, TestAreaChange[]> = new Map(),
  filesByStep: Map<string, Map<string, FileSnapshot>> = new Map(),
  referenceFilesByStep: Map<string, Map<string, FileSnapshot>> = new Map(),
  manualEvidence: Evidence[] = [],
  testExecution?: NarrativeTestExecution,
): RenderModel {
  const sourcePatch = readArtifact(manifestPath, manifest.source.diff).toString("utf8");
  const steps = manifest.steps.map((step, index) => {
    const referenceSnapshots = referenceFilesByStep.get(step.id) ?? new Map<string, FileSnapshot>();
    const body = step.body
      ? inlineMarkdownImages(readArtifact(manifestPath, step.body).toString("utf8"), step.body, manifestPath)
      : "";
    const patch = step.diff ? readArtifact(manifestPath, step.diff).toString("utf8") : "";
    const fileDiffs = patch ? splitPatchFiles(patch).map((file) => ({
      ...file,
      ...filesByStep.get(step.id)?.get(file.path),
    })) : [];
    const changedPaths = new Set(fileDiffs.map((file) => file.path));
    const knownPaths = new Set([...changedPaths, ...referenceSnapshots.keys()]);
    const describeFile = (file: Callsite): Callsite => {
      if (file.change) return file;
      const snapshot = filesByStep.get(step.id)?.get(file.file);
      const patch = fileDiffs.find((candidate) => candidate.path === file.file)?.patch ?? "";
      const change = snapshot?.beforeContent === null || /^new file mode /m.test(patch)
        ? "added"
        : snapshot?.afterContent === null || /^deleted file mode /m.test(patch) ? "removed" : "changed";
      return { ...file, change };
    };
    const interfaces = step.interfaces?.map((item) => ({
      ...item,
      callsites: item.callsites.map(describeFile),
    }));
    const sections = step.sections?.map((section) => ({
      ...section,
      description: rewriteRepositoryFileLinks(
        inlineMarkdownImages(section.description, step.body ?? "narrative.json", manifestPath), knownPaths,
      ),
      files: section.files.map(describeFile),
    }));
    const referenceFiles = [...referenceSnapshots]
      .filter(([path]) => !changedPaths.has(path))
      .map(([path, snapshot]) => ({
        path,
        patch: snapshot.afterContent === null ? "" : snapshotPatch(snapshot.afterContent),
        ...snapshot,
      }));
    if (patch) assertStepFileCoverage(step, fileDiffs);
    const explicitEvidenceUrls = new Set([
      ...(step.evidence ?? []).map((item) => item.url),
      ...step.checks.automated.flatMap((check) => check.evidence ?? []).map((item) => item.url),
      ...step.checks.manual.flatMap((check) => check.evidence ?? []).map((item) => item.url),
    ]);
    return {
      ...step,
      interfaces,
      sections,
      number: index + 1,
      body: rewriteRepositoryFileLinks(body, knownPaths),
      patch,
      fileDiffs,
      referenceFiles,
      stats: patch ? patchStats(patch) : { additions: 0, deletions: 0, files: 0 },
      testAreas: step.kind === "tests" ? (testAreasByStep.get(step.id) ?? []) : undefined,
      evidence: [
        ...(step.evidence ?? []),
        ...(step.kind === "manual" ? manualEvidence.filter((item) => !explicitEvidenceUrls.has(item.url)) : []),
      ],
      testRun: testExecution?.runsByStep.get(step.id),
    };
  });
  return {
    title: manifest.title,
    summary: manifest.summary,
    source: { ...manifest.source, stats: patchStats(sourcePatch) },
    verification,
    testExecution: testExecution?.metadata,
    steps,
  };
}

function snapshotPatch(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return "@@ -0,0 +0,0 @@\n";
  return `@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map((line) => ` ${line}`).join("\n")}\n`;
}
