import type { ReviewComment, ReviewCommentTarget, ReviewDraft, ReviewDraftPreview } from "@thestraylight/heptapod-core/types";

export interface DraftState { draft: ReviewDraft; preview: ReviewDraftPreview }
export interface CommentEditor {
  id: string; target: ReviewCommentTarget; body: string; anchorId?: string; position: { x: number; y: number };
}
export interface ReviewCommentSnapshot {
  state: DraftState | null;
  saving: boolean;
  publishing: boolean;
  error: string | null;
  editor: CommentEditor | null;
  focusedComment: { id: string; sequence: number } | null;
}

export function createReviewCommentStore() {
  const initial: ReviewCommentSnapshot = { state: null, saving: false, publishing: false, error: null, editor: null, focusedComment: null };
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update: (change: Partial<ReviewCommentSnapshot>) => {
      const next = { ...snapshot, ...change };
      if ((Object.keys(change) as (keyof ReviewCommentSnapshot)[]).every((key) => Object.is(snapshot[key], next[key]))) return;
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}

export function createReviewSelection<T>(store: ReturnType<typeof createReviewCommentStore>, select: (snapshot: ReviewCommentSnapshot) => T, equal: (a: T, b: T) => boolean, previous: { value: T } | null) {
  let snapshot = store.getSnapshot();
  const value = select(snapshot);
  let selected = previous && equal(previous.value, value) ? previous.value : value;
  const serverValue = select(store.getServerSnapshot());
  return {
    subscribe: store.subscribe,
    getServerSnapshot: () => serverValue,
    getSnapshot: () => {
      const next = store.getSnapshot();
      if (next !== snapshot) {
        const value = select(next);
        if (!equal(selected, value)) selected = value;
        snapshot = next;
      }
      return selected;
    },
  };
}

export function sameItems<T>(a: readonly T[], b: readonly T[]) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function codeCommentLocations(snapshot: ReviewCommentSnapshot, stepId: string | undefined, path: string): Pick<ReviewComment, "id" | "target">[] {
  return (snapshot.state?.draft.comments ?? [])
    .filter((comment) => comment.target.kind === "line" && comment.target.stepId === stepId && comment.target.path === path)
    .map(({ id, target }) => ({ id, target }));
}

export function sameCommentLocations(a: Pick<ReviewComment, "id" | "target">[], b: Pick<ReviewComment, "id" | "target">[]) {
  return a.length === b.length && a.every((comment, index) => comment.id === b[index].id && comment.target === b[index].target);
}
