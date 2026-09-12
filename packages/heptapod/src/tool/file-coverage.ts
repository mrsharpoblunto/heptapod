import type { NarrativeStep, PatchFile } from "./types.js";

export function stepFileReferences(step: NarrativeStep): Array<{ path: string; label: string }> {
  if (step.kind === "implementation") return (step.sections ?? []).flatMap((section, index) =>
    section.files.map((file) => ({ path: file.file, label: `${step.id}.sections[${index}].files` })));
  if (step.kind === "tests") return (step.cases ?? []).flatMap((area, index) =>
    area.files.map((path) => ({ path, label: `${step.id}.cases[${index}].files` })));
  if (step.kind === "refactor") return (step.interfaces ?? []).flatMap((item, index) => [
    ...(item.file ? [{ path: item.file, label: `${step.id}.interfaces[${index}].file` }] : []),
    ...item.callsites.map((callsite) => ({ path: callsite.file, label: `${step.id}.interfaces[${index}].callsites` })),
  ]);
  return [];
}

/** Every visible changed file must have an explicit place in the main content. */
export function assertStepFileCoverage(step: NarrativeStep, fileDiffs: PatchFile[], generated: ReadonlySet<string> = new Set()): void {
  if (!["tests", "implementation", "refactor"].includes(step.kind)) return;
  const changed = new Set(fileDiffs.filter((file) => !generated.has(file.path)).map((file) => file.path));
  const covered = new Set<string>();
  const include = (path: string, label: string) => {
    if (generated.has(path)) throw new Error(`${label} refers to ${path}, which is excluded from review by the linguist-generated Git attribute. Remove it from the section; keep its changes in the step patch.`);
    if (!changed.has(path)) {
      throw new Error(`${label} refers to ${path}, which is not changed by ${step.diff}.`);
    }
    if (step.kind === "implementation" && covered.has(path)) {
      throw new Error(`Step ${step.id} lists ${path} more than once in its implementation sections.`);
    }
    covered.add(path);
  };
  for (const { path, label } of stepFileReferences(step)) include(path, label);
  const missing = [...changed].filter((path) => !covered.has(path));
  if (missing.length > 0) {
    throw new Error(`Step ${step.id} (${step.kind}) does not account for ${missing.length} file(s) changed by ${step.diff}:\n${missing.map((path) => `- ${path}`).join("\n")}`);
  }
}
