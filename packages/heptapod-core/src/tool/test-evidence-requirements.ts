import type { NarrativeManifest, NarrativeStep, CheckStatus } from "./types.js";
import type { ParsedTestCase } from "./test-fixtures/types.js";

export interface EvidenceFixture { file: string; deleted: boolean; tests: Array<ParsedTestCase & { removed?: boolean }> }
export interface EvidenceRequirement {
  target: string;
  label: string;
  kind: "check" | "area" | "fixture" | "test";
  files: string[];
  expectedStatus?: CheckStatus;
  command?: string;
  notApplicable: boolean;
  name?: string;
  selectors?: string[];
  occurrence?: number;
}

/** Targets come from metadata/source, never from the submitted results. */
export function stepEvidenceRequirements(step: NarrativeStep, fixtures: EvidenceFixture[]): EvidenceRequirement[] {
  return [
    ...step.checks.automated.map((check, index): EvidenceRequirement => ({
      target: `automated/${index}`, label: check.label, kind: "check", files: [],
      expectedStatus: check.status, command: check.command, notApplicable: check.status === "not-applicable",
    })),
    ...(step.cases ?? []).map((area, index): EvidenceRequirement => ({
      target: `area/${index}`, label: area.name, kind: "area",
      files: area.files.filter(file => fixtures.some(fixture => fixture.file === file && !fixture.deleted)),
      notApplicable: !area.files.some(file => fixtures.some(fixture => fixture.file === file && !fixture.deleted)),
    })),
    ...fixtures.flatMap((fixture): EvidenceRequirement[] => [
      { target: `fixture/${encodeURIComponent(fixture.file)}`, label: fixture.file, kind: "fixture", files: [fixture.file], notApplicable: fixture.deleted },
      ...fixture.tests.map((test, index): EvidenceRequirement => ({
        target: `test/${encodeURIComponent(fixture.file)}/${index}`, label: test.name, kind: "test", files: [fixture.file],
        name: test.selectors ? test.name : test.key.split("\0").join(" "), selectors: test.selectors,
        occurrence: fixture.tests.slice(0, index).filter(prior => prior.key === test.key).length,
        notApplicable: Boolean(test.removed),
      })),
    ]),
  ];
}
export function evidenceRequirements(manifest: NarrativeManifest, fixturesByStep: Map<string, EvidenceFixture[]>) {
  return new Map(manifest.steps.map(step => [step.id, stepEvidenceRequirements(step, fixturesByStep.get(step.id) ?? [])]));
}
