import { readArtifact } from "./manifest.js";
import {
  applyPatchToIndex,
  canonicalDiff,
  resolveCommit,
  resolveTree,
  stagedDiff,
  stagedTree,
  withTemporaryIndex,
} from "./git.js";
import { splitPatchFiles } from "./patch.js";
import type { NarrativeManifest, NarrativeStep, VerificationResult } from "./types.js";

function firstDifference(expected: Buffer, actual: Buffer) {
  const length = Math.min(expected.length, actual.length);
  let byte = 0;
  while (byte < length && expected[byte] === actual[byte]) byte += 1;
  if (byte === expected.length && byte === actual.length) return null;
  const prefix = expected.subarray(0, byte).toString("utf8");
  const line = prefix.split("\n").length;
  const expectedLine = expected.toString("utf8").split("\n")[line - 1] ?? "<end of file>";
  const actualLine = actual.toString("utf8").split("\n")[line - 1] ?? "<end of file>";
  return { byte, line, expectedLine, actualLine };
}

function mismatchMessage(label: string, expected: Buffer, actual: Buffer): string {
  const mismatch = firstDifference(expected, actual);
  if (!mismatch) return "";
  return `${label} differs at byte ${mismatch.byte} (line ${mismatch.line}).\nExpected: ${mismatch.expectedLine}\nActual:   ${mismatch.actualLine}`;
}

function verifyFileReferences(step: NarrativeStep, patch: Buffer): void {
  const files = new Set(splitPatchFiles(patch.toString("utf8")).map((file) => file.path));
  const requireFile = (path: string, label: string) => {
    if (!files.has(path)) throw new Error(`${label} refers to ${path}, which is not changed by ${step.diff}.`);
  };
  if (step.kind === "implementation") {
    step.focus?.forEach((path, index) => requireFile(path, `${step.id}.focus[${index}]`));
  } else if (step.kind === "refactor") {
    step.interfaces?.forEach((item, index) => {
      if (item.file) requireFile(item.file, `${step.id}.interfaces[${index}].file`);
      item.callsites.forEach((callsite, callsiteIndex) => requireFile(callsite.file, `${step.id}.interfaces[${index}].callsites[${callsiteIndex}].file`));
    });
  } else if (step.kind === "tests") {
    step.cases?.forEach((item, index) => item.files.forEach((path) => requireFile(path, `${step.id}.cases[${index}].files`)));
  }
}

export function verifyNarrative(
  repo: string,
  manifest: NarrativeManifest,
  manifestPath: string,
): VerificationResult {
  const base = resolveCommit(repo, manifest.source.base);
  const head = resolveCommit(repo, manifest.source.head);
  if (base !== manifest.source.base || head !== manifest.source.head) {
    throw new Error("The source base and head must be immutable full commit IDs. Run capture again to pin them.");
  }

  const source = readArtifact(manifestPath, manifest.source.diff);
  const currentSource = canonicalDiff(repo, base, head);
  if (!source.equals(currentSource)) {
    throw new Error(`The captured source diff no longer matches its base/head commits.\n${mismatchMessage("Source diff", source, currentSource)}`);
  }

  const patchSteps = manifest.steps.filter(
    (step): step is NarrativeStep & { diff: string } => typeof step.diff === "string",
  );
  if (patchSteps.length === 0 && source.length > 0) {
    throw new Error("The source diff is non-empty but the narrative has no patch-bearing steps.");
  }

  return withTemporaryIndex(repo, base, ({ env }) => {
    for (const [index, step] of patchSteps.entries()) {
      const patch = readArtifact(manifestPath, step.diff);
      if (patch.length === 0) throw new Error(`Step patch ${step.diff} is empty.`);
      verifyFileReferences(step, patch);
      applyPatchToIndex(repo, env, patch, `${index + 1} (${step.id})`);
    }

    const actualTree = stagedTree(repo, env);
    const expectedTree = resolveTree(repo, head);
    if (actualTree !== expectedTree) {
      throw new Error(`The stacked steps produce tree ${actualTree}, but source.head is ${expectedTree}.`);
    }

    const reconstructed = stagedDiff(repo, env, base);
    if (!source.equals(reconstructed)) {
      throw new Error(`The stacked steps reach the right tree but do not reproduce the source diff byte-for-byte.\n${mismatchMessage("Reconstructed diff", source, reconstructed)}`);
    }

    return {
      base,
      head,
      tree: actualTree,
      sourceBytes: source.length,
      patchSteps: patchSteps.length,
      exact: true,
    };
  });
}
