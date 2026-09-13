import type { NarrativeStep, PatchFile } from "./types.js";

/** Validate against patch lines so authoring errors are caught by `validate`,
 * before ingestion runs tests or builds optional structural diffs. */
export function assertStepExplanations(step: NarrativeStep, files: PatchFile[], generated: ReadonlySet<string>): void {
  if (step.explanations === undefined) return;
  const fail = (message: string): never => { throw new Error(`Invalid narrative: step ${step.id} explanations ${message}`); };
  if (!Array.isArray(step.explanations)) fail("must be an array");
  for (const [index, note] of step.explanations.entries()) {
    const label = `[${index}]`;
    if (!note || typeof note !== "object") fail(`${label} must be an object`);
    if (typeof note.file !== "string" || !note.file.trim()) fail(`${label}.file must be a non-empty repository-relative path`);
    if (note.side !== "LEFT" && note.side !== "RIGHT") fail(`${label}.side must be LEFT or RIGHT`);
    if (!Number.isSafeInteger(note.startLine) || note.startLine < 1) fail(`${label}.startLine must be a positive integer`);
    if (note.endLine !== undefined && !Number.isSafeInteger(note.endLine)) fail(`${label}.endLine must be an integer`);
    const end = note.endLine ?? note.startLine;
    if (!Number.isSafeInteger(end) || end < note.startLine) fail(`${label}.endLine must be an integer at or after startLine`);
    if (typeof note.text !== "string" || !note.text.trim() || note.text.length > 2000) fail(`${label}.text must contain 1–2000 characters`);
    if (generated.has(note.file)) fail(`${label} references excluded generated file ${note.file}`);
    const file = files.find((file) => file.path === note.file);
    if (!file) fail(`${label}.file must belong to this step's diff: ${note.file}`);
    if (/^(?:GIT binary patch|Binary files )/m.test(file!.patch)) fail(`${label} cannot annotate a binary file`);
    const available = new Set<number>();
    let old: number | undefined, next: number | undefined;
    for (const line of file!.patch.split("\n")) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); continue; }
      if (old === undefined || next === undefined) continue;
      if (line.startsWith(" ")) { available.add(note.side === "LEFT" ? old : next); old++; next++; }
      else if (line.startsWith("-")) { if (note.side === "LEFT") available.add(old); old++; }
      else if (line.startsWith("+")) { if (note.side === "RIGHT") available.add(next); next++; }
    }
    if (end - note.startLine + 1 > available.size
      || Array.from({ length: end - note.startLine + 1 }, (_, offset) => note.startLine + offset).some((line) => !available.has(line))) {
      fail(`${label} ${note.side} lines ${note.startLine}–${end} must be present in the step's diff for ${note.file}`);
    }
  }
}
