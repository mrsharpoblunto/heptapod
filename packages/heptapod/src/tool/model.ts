import { readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { patchStats, splitPatchFiles } from "./patch.js";
import { rewriteRepositoryFileLinks } from "./markdown-references.js";
import { readArtifact, resolveArtifactPath } from "./manifest.js";
import type {
  NarrativeManifest,
  NarrativeStep,
  PatchFile,
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

function assertStepFileMetadata(step: NarrativeStep, fileDiffs: PatchFile[]): void {
  const files = new Set(fileDiffs.map((file) => file.path));
  const ensure = (path: string, label: string) => {
    if (!files.has(path)) throw new Error(`${label} refers to ${path}, which is not changed by ${step.diff}.`);
  };
  if (step.kind === "implementation") {
    step.focus?.forEach((path, index) => ensure(path, `${step.id}.focus[${index}]`));
  }
  if (step.kind === "refactor") {
    step.interfaces?.forEach((item, index) => {
      if (item.file) ensure(item.file, `${step.id}.interfaces[${index}].file`);
      item.callsites.forEach((callsite, callsiteIndex) => ensure(callsite.file, `${step.id}.interfaces[${index}].callsites[${callsiteIndex}].file`));
    });
  }
  if (step.kind === "tests") {
    step.cases?.forEach((item, index) => item.files.forEach((path) => ensure(path, `${step.id}.cases[${index}].files`)));
  }
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
    const interfaces = step.interfaces?.map((item) => ({
      ...item,
      callsites: item.callsites.map((callsite) => {
        if (callsite.change) return callsite;
        const snapshot = filesByStep.get(step.id)?.get(callsite.file);
        const change = snapshot?.beforeContent === null
          ? "added"
          : snapshot?.afterContent === null
            ? "removed"
            : "changed";
        return { ...callsite, change } as const;
      }),
    }));
    const referenceFiles = [...referenceSnapshots]
      .filter(([path]) => !changedPaths.has(path))
      .map(([path, snapshot]) => ({
        path,
        patch: snapshot.afterContent === null ? "" : snapshotPatch(snapshot.afterContent),
        ...snapshot,
      }));
    if (patch) assertStepFileMetadata(step, fileDiffs);
    const explicitEvidenceUrls = new Set([
      ...(step.evidence ?? []).map((item) => item.url),
      ...step.checks.automated.flatMap((check) => check.evidence ?? []).map((item) => item.url),
      ...step.checks.manual.flatMap((check) => check.evidence ?? []).map((item) => item.url),
    ]);
    return {
      ...step,
      interfaces,
      number: index + 1,
      body: rewriteRepositoryFileLinks(body, new Set([...changedPaths, ...referenceSnapshots.keys()])),
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
