import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { assertStepFileCoverage, stepFileReferences } from "./file-coverage.js";
import { generatedFiles } from "./generated-files.js";
import { extractRepositoryFileReferences } from "./markdown-references.js";
import { splitPatchFiles } from "./patch.js";
import type {
  Callsite,
  Evidence,
  InterfaceChange,
  NarrativeManifest,
  NarrativeStep,
  StepChecks,
  TestCase,
} from "./types.js";

const STEP_KINDS = new Set(["description", "tests", "refactor", "implementation", "manual"]);
const PATCH_KINDS = new Set(["tests", "refactor", "implementation"]);
const CHECK_STATUSES = new Set(["passing", "failing", "not-run", "blocked", "not-applicable"]);
const CHECK_BASES = new Set(["observed", "expected"]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid narrative: ${message}`);
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  assert(typeof value === "string" && value.trim() !== "", `${label} must be a non-empty string`);
}

function validateEvidence(evidence: Evidence[], label: string): void {
  assert(Array.isArray(evidence), `${label} must be an array`);
  evidence.forEach((item, index) => {
    const itemLabel = `${label}[${index}]`;
    assert(item && typeof item === "object", `${itemLabel} must be an object`);
    nonEmptyString(item.url, `${itemLabel}.url`);
    nonEmptyString(item.label, `${itemLabel}.label`);
    assert(item.kind === "image" || item.kind === "video" || item.kind === "link", `${itemLabel}.kind must be image, video, or link`);
    if (item.sourceUrl !== undefined) nonEmptyString(item.sourceUrl, `${itemLabel}.sourceUrl`);
  });
}

export function resolveArtifactPath(manifestPath: string, artifactPath: string, label: string): string {
  nonEmptyString(artifactPath, label);
  const root = dirname(resolve(manifestPath));
  const target = resolve(root, artifactPath);
  const traversal = relative(root, target);
  assert(traversal !== ".." && !traversal.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), `${label} must stay inside the artifact directory`);
  assert(existsSync(target), `${label} does not exist: ${artifactPath}`);
  return target;
}

function validateChecks(checks: StepChecks, label: string): void {
  assert(checks && typeof checks === "object", `${label}.checks is required`);
  for (const group of ["automated", "manual"] as const) {
    assert(Array.isArray(checks[group]), `${label}.checks.${group} must be an array`);
    for (const [index, check] of checks[group].entries()) {
      const checkLabel = `${label}.checks.${group}[${index}]`;
      assert(check && typeof check === "object", `${checkLabel} must be an object`);
      nonEmptyString(check.label, `${checkLabel}.label`);
      assert(CHECK_STATUSES.has(check.status), `${checkLabel}.status must be one of ${[...CHECK_STATUSES].join(", ")}`);
      assert(CHECK_BASES.has(check.basis), `${checkLabel}.basis must be observed or expected`);
      if (check.command !== undefined) nonEmptyString(check.command, `${checkLabel}.command`);
      if (check.detail !== undefined) nonEmptyString(check.detail, `${checkLabel}.detail`);
      if (check.evidence !== undefined) validateEvidence(check.evidence, `${checkLabel}.evidence`);
    }
  }
}

function validateFileReferences(
  items: Array<TestCase | InterfaceChange | Callsite>,
  label: string,
): void {
  assert(Array.isArray(items), `${label} must be an array`);
  for (const [index, item] of items.entries()) {
    assert(item && typeof item === "object", `${label}[${index}] must be an object`);
    nonEmptyString("label" in item ? item.label : item.name, `${label}[${index}].label or .name`);
    if ("file" in item && item.file !== undefined) {
      nonEmptyString(item.file, `${label}[${index}].file`);
    }
    if ("file" in item && "change" in item && item.change !== undefined) {
      assert(
        item.change === "added" || item.change === "removed" || item.change === "changed",
        `${label}[${index}].change must be added, removed, or changed`,
      );
    }
    if ("files" in item && item.files !== undefined) {
      assert(Array.isArray(item.files) && item.files.length > 0, `${label}[${index}].files must be a non-empty array`);
      item.files.forEach((file, fileIndex) => nonEmptyString(file, `${label}[${index}].files[${fileIndex}]`));
    }
  }
}

export function loadManifest(manifestPath: string, repo?: string): {
  manifest: NarrativeManifest;
  manifestPath: string;
  generated: Set<string>;
} {
  const absolutePath = resolve(manifestPath);
  let manifest: NarrativeManifest;
  try {
    manifest = JSON.parse(readFileSync(absolutePath, "utf8")) as NarrativeManifest;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read narrative manifest ${absolutePath}: ${message}`);
  }

  assert(manifest && typeof manifest === "object", "the root must be an object");
  assert(manifest.schemaVersion === 1, "schemaVersion must be 1");
  nonEmptyString(manifest.title, "title");
  nonEmptyString(manifest.summary, "summary");
  assert(manifest.source && typeof manifest.source === "object", "source is required");
  nonEmptyString(manifest.source.base, "source.base");
  nonEmptyString(manifest.source.head, "source.head");
  nonEmptyString(manifest.source.diff, "source.diff");
  resolveArtifactPath(absolutePath, manifest.source.diff, "source.diff");
  if (manifest.source.github !== undefined) {
    assert(manifest.source.github && typeof manifest.source.github === "object", "source.github must be an object");
    nonEmptyString(manifest.source.github.pullRequestUrl, "source.github.pullRequestUrl");
    nonEmptyString(manifest.source.github.repositoryUrl, "source.github.repositoryUrl");
    assert(Number.isInteger(manifest.source.github.number) && manifest.source.github.number > 0, "source.github.number must be a positive integer");
  }
  assert(Array.isArray(manifest.steps) && manifest.steps.length > 0, "steps must be a non-empty array");
  assert(manifest.steps[0].kind === "description", "the first step must be a description step");

  const ids = new Set();
  for (const [index, step] of manifest.steps.entries()) {
    const label = `steps[${index}]`;
    assert(step && typeof step === "object", `${label} must be an object`);
    nonEmptyString(step.id, `${label}.id`);
    assert(!ids.has(step.id), `${label}.id must be unique (${step.id})`);
    ids.add(step.id);
    nonEmptyString(step.title, `${label}.title`);
    assert(STEP_KINDS.has(step.kind), `${label}.kind must be one of ${[...STEP_KINDS].join(", ")}`);
    validateChecks(step.checks, label);
    if (step.evidence !== undefined) validateEvidence(step.evidence, `${label}.evidence`);

    if (step.body !== undefined) {
      nonEmptyString(step.body, `${label}.body`);
      assert(extname(step.body).toLowerCase() === ".md", `${label}.body must point to a Markdown file`);
      resolveArtifactPath(absolutePath, step.body, `${label}.body`);
    }

    if (PATCH_KINDS.has(step.kind)) {
      nonEmptyString(step.diff, `${label}.diff`);
      assert(extname(step.diff).toLowerCase() === ".diff", `${label}.diff must point to a .diff file`);
      resolveArtifactPath(absolutePath, step.diff, `${label}.diff`);
    } else {
      assert(step.diff === undefined, `${label} (${step.kind}) cannot contain a diff`);
      assert(step.body !== undefined, `${label} (${step.kind}) requires a Markdown body`);
    }

    if (step.kind === "tests") {
      assert(step.cases, `${label}.cases is required`);
      validateFileReferences(step.cases, `${label}.cases`);
      step.cases.forEach((testCase, caseIndex) => {
        nonEmptyString(testCase.description, `${label}.cases[${caseIndex}].description`);
        assert(Array.isArray(testCase.files) && testCase.files.length > 0, `${label}.cases[${caseIndex}].files must link at least one changed file`);
      });
    }
    if (step.kind === "refactor") {
      assert(step.interfaces, `${label}.interfaces is required`);
      assert(!("callsites" in step), `${label}.callsites must be nested under each interface`);
      validateFileReferences(step.interfaces, `${label}.interfaces`);
      let callsiteCount = 0;
      step.interfaces.forEach((item, interfaceIndex) => {
        const interfaceLabel = `${label}.interfaces[${interfaceIndex}]`;
        assert(Array.isArray(item.callsites), `${interfaceLabel}.callsites must be an array`);
        validateFileReferences(item.callsites, `${interfaceLabel}.callsites`);
        item.callsites.forEach((callsite, callsiteIndex) => nonEmptyString(callsite.file, `${interfaceLabel}.callsites[${callsiteIndex}].file`));
        callsiteCount += item.callsites.length;
      });
      assert(step.interfaces.length === 0 || callsiteCount > 0, `${label}.interfaces must contain at least one callsite`);
    }
    if (step.kind === "implementation") {
      assert(!("focus" in step), `${label}.focus is no longer supported; use Critical/Secondary sections covering every changed file`);
      assert(Array.isArray(step.sections), `${label}.sections must be an array`);
      step.sections.forEach((section, sectionIndex) => {
        const sectionLabel = `${label}.sections[${sectionIndex}]`;
        assert(section && typeof section === "object", `${sectionLabel} must be an object`);
        nonEmptyString(section.name, `${sectionLabel}.name`);
        nonEmptyString(section.description, `${sectionLabel}.description`);
        assert(section.priority === "critical" || section.priority === "secondary", `${sectionLabel}.priority must be critical or secondary`);
        assert(Array.isArray(section.files) && section.files.length > 0, `${sectionLabel}.files must be a non-empty array`);
        validateFileReferences(section.files, `${sectionLabel}.files`);
        section.files.forEach((file, fileIndex) => {
          nonEmptyString(file.label, `${sectionLabel}.files[${fileIndex}].label`);
          nonEmptyString(file.file, `${sectionLabel}.files[${fileIndex}].file`);
        });
      });
    }
  }

  const generated = repo ? resolveGeneratedFiles(repo, manifest, absolutePath) : new Set<string>();
  assertNarrativeFileCoverage(manifest, absolutePath, generated);
  return { manifest, manifestPath: absolutePath, generated };
}

export function readArtifact(manifestPath: string, artifactPath: string): Buffer {
  return readFileSync(resolveArtifactPath(manifestPath, artifactPath, artifactPath));
}

export function readStepMarkdown(step: NarrativeStep, manifestPath: string): string {
  return [
    step.body ? readArtifact(manifestPath, step.body).toString("utf8") : "",
    ...(step.sections ?? []).map((section) => section.description),
    ...(step.cases ?? []).map((area) => area.description),
    ...(step.interfaces ?? []).flatMap((item) => [item.description, item.before, item.after]),
  ].filter(Boolean).join("\n\n");
}

/** Use the target repository's current rules, even when reviewing older commits. */
export function resolveGeneratedFiles(repo: string, manifest: NarrativeManifest, manifestPath: string): Set<string> {
  const paths = manifest.source.files?.map((file) => file.path) ?? [];
  for (const step of manifest.steps) {
    if (step.diff) paths.push(...splitPatchFiles(readArtifact(manifestPath, step.diff).toString("utf8")).map((file) => file.path));
    paths.push(...stepFileReferences(step).map((file) => file.path));
    paths.push(...extractRepositoryFileReferences(readStepMarkdown(step, manifestPath)));
  }
  return generatedFiles(repo, paths);
}

export function assertNarrativeFileCoverage(manifest: NarrativeManifest, manifestPath: string, generated: ReadonlySet<string>): void {
  for (const step of manifest.steps) {
    if (step.diff) assertStepFileCoverage(step, splitPatchFiles(readArtifact(manifestPath, step.diff).toString("utf8")), generated);
    for (const path of extractRepositoryFileReferences(readStepMarkdown(step, manifestPath))) {
      assert(!generated.has(path), `step ${step.id} links to ${path}, which is excluded from review by the linguist-generated Git attribute. Remove the file link.`);
    }
  }
}
