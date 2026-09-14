import type { Check, RenderStep } from "./types.js";

export interface ManualTestState {
  head: string;
  testedChecks: string[];
}

export interface ManualTest {
  id: string;
  check: Check;
  stepId: string;
}

export function manualTestId(check: Check): string {
  return JSON.stringify([check.label, check.command ?? "", check.detail ?? ""]);
}

export function accumulatedManualTests(steps: RenderStep[], stepIndex: number): ManualTest[] {
  const checks = new Map<string, ManualTest>();
  for (const step of steps.slice(0, stepIndex + 1)) {
    for (const check of step.checks.manual) {
      const id = manualTestId(check);
      if (!checks.has(id)) checks.set(id, { id, check, stepId: step.id });
    }
  }
  return [...checks.values()];
}
