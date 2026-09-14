"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Check, RenderStep } from "@thestraylight/heptapod-core/types";
import { accumulatedManualTests, manualTestId } from "@thestraylight/heptapod-core/manual-tests";
import { createManualTestStore } from "./manual-test-store";

const ManualTestsContext = createContext<{ store: ReturnType<typeof createManualTestStore>; disabled: boolean } | null>(null);

export function ManualTestsProvider({ reviewId, head, disabled = false, children }: {
  reviewId?: string; head: string; disabled?: boolean; children: ReactNode;
}) {
  const endpoint = reviewId ? `/api/service/reviews/${encodeURIComponent(reviewId)}/manual-tests` : null;
  const store = useMemo(() => createManualTestStore(head, endpoint), [head, endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    void store.load(controller.signal);
    return () => controller.abort();
  }, [store]);
  return <ManualTestsContext.Provider value={{ store, disabled }}>{children}</ManualTestsContext.Provider>;
}

function useManualTests() {
  const context = useContext(ManualTestsContext);
  if (!context) throw new Error("Manual tests require a review.");
  const snapshot = useSyncExternalStore(context.store.subscribe, context.store.getSnapshot, context.store.getServerSnapshot);
  return { ...context, ...snapshot };
}

export function ManualTestStatus({ check }: { check: Check }) {
  const state = useManualTests();
  const id = manualTestId(check);
  const tested = state.testedChecks.includes(id);
  return <select aria-label={`Manual test status for ${check.label}`}
    className={`manual-test-status status status-${tested ? "passing" : "not-run"}`}
    value={tested ? "tested" : "not-tested"}
    disabled={state.disabled || !state.loaded || state.pending.includes(id)}
    aria-busy={state.pending.includes(id)}
    onChange={event => { void state.store.setTested(id, event.target.value === "tested"); }}>
    <option value="not-tested">Not tested</option>
    <option value="tested">Tested</option>
  </select>;
}

export function ManualTestFeedback() {
  const state = useManualTests();
  return state.error ? <div className="manual-test-error" role="alert">{state.error}
    {!state.loaded && <button onClick={() => { void state.store.load(); }}>Retry loading</button>}
  </div> : null;
}

export function ManualTestList({ steps, stepIndex }: { steps: RenderStep[]; stepIndex: number }) {
  const state = useManualTests();
  const tests = accumulatedManualTests(steps, stepIndex);
  return <section className="check-group manual-checks">
    <div className="test-summary-heading">
      <div className="eyebrow">Manual checks</div>
      <span className="test-summary-count">{state.loaded
        ? `${tests.filter(test => state.testedChecks.includes(test.id)).length}/${tests.length} tested` : "Loading…"}</span>
    </div>
    <ManualTestFeedback />
    {!tests.length ? <p className="muted compact-copy">No manual checks apply at this point.</p> : tests.map(({ id, check }) =>
      <div className="check" key={id}>
        <div className="check-heading"><span>{check.label}</span><ManualTestStatus check={check} /></div>
        {check.command && <code className="command">{check.command}</code>}
        {check.detail && <p>{check.detail}</p>}
      </div>)}
  </section>;
}
