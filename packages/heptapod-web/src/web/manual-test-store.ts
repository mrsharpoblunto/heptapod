import type { ManualTestState } from "@thestraylight/heptapod-core/manual-tests";

export interface ManualTestSnapshot {
  testedChecks: string[];
  pending: string[];
  loaded: boolean;
  error: string | null;
}

export function createManualTestStore(head: string, endpoint: string | null, request: typeof fetch = fetch) {
  const initial: ManualTestSnapshot = { testedChecks: [], pending: [], loaded: !endpoint, error: null };
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const update = (change: Partial<ManualTestSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    listeners.forEach(listener => listener());
  };
  async function read(response: Response): Promise<ManualTestState> {
    const result = await response.json() as ManualTestState & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Could not save manual test status.");
    if (result.head !== head) throw new Error("The review changed. Reload to see the current manual tests.");
    return result;
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async load(signal?: AbortSignal) {
      if (!endpoint) return;
      update({ error: null });
      try {
        const result = await read(await request(endpoint, { signal }));
        if (!signal?.aborted) update({ testedChecks: result.testedChecks, loaded: true });
      } catch (error) {
        if (!signal?.aborted) update({ error: error instanceof Error ? error.message : "Could not load manual test status." });
      }
    },
    async setTested(checkId: string, tested: boolean) {
      if (!snapshot.loaded || snapshot.pending.includes(checkId)) return;
      const previous = snapshot.testedChecks.includes(checkId);
      const set = (value: boolean) => [...snapshot.testedChecks.filter(id => id !== checkId), ...(value ? [checkId] : [])];
      update({ testedChecks: set(tested), pending: [...snapshot.pending, checkId], error: null });
      try {
        if (endpoint) await read(await request(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ head, checkId, tested }) }));
      } catch (error) {
        update({ testedChecks: set(previous), error: error instanceof Error ? error.message : "Could not save manual test status." });
      } finally { update({ pending: snapshot.pending.filter(id => id !== checkId) }); }
    },
  };
}
