import type { NarrativeStep, PatchFile } from "./types.js";

/** Every changed file must have an explicit place in the step's main content. */
export function assertStepFileCoverage(step: NarrativeStep, fileDiffs: PatchFile[]): void {
  if (!["tests", "implementation", "refactor"].includes(step.kind)) return;
  const changed = new Set(fileDiffs.map((file) => file.path));
  const covered = new Set<string>();
  const include = (path: string, label: string) => {
    if (!changed.has(path)) {
      throw new Error(`${label} refers to ${path}, which is not changed by ${step.diff}.`);
    }
    if (step.kind === "implementation" && covered.has(path)) {
      throw new Error(`Step ${step.id} lists ${path} more than once in its implementation sections.`);
    }
    covered.add(path);
  };
  if (step.kind === "implementation") {
    step.sections?.forEach((section, index) => section.files.forEach((file) =>
      include(file.file, `${step.id}.sections[${index}].files`)));
  } else if (step.kind === "tests") {
    step.cases?.forEach((area, index) => area.files.forEach((path) =>
      include(path, `${step.id}.cases[${index}].files`)));
  } else {
    step.interfaces?.forEach((item, index) => {
      if (item.file) include(item.file, `${step.id}.interfaces[${index}].file`);
      item.callsites.forEach((callsite) =>
        include(callsite.file, `${step.id}.interfaces[${index}].callsites`));
    });
  }
  const missing = [...changed].filter((path) => !covered.has(path));
  if (missing.length > 0) {
    throw new Error(`Step ${step.id} (${step.kind}) does not account for ${missing.length} file(s) changed by ${step.diff}:\n${missing.map((path) => `- ${path}`).join("\n")}`);
  }
}
