"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, ExternalLink, GripHorizontal, MessageSquare, Send, X } from "lucide-react";
import type { RenderModel, RenderStep, ReviewComment, ReviewCommentTarget } from "@thestraylight/heptapod-core/types";
import { useToast, ToastMessage } from "./Toasts";
import { createReviewCommentStore, createReviewSelection, sameItems, type ReviewCommentSnapshot, type DraftState, type CommentEditor } from "./review-comment-store";
import { createCommentHover } from "./comment-hover";
import { GitHubIcon, useCachedGitHubPullRequestMetadata } from "./GitHubIdentity";

interface AnchorRect { left: number; right: number; top: number; bottom: number }
interface ReviewCommentActions {
  store: ReturnType<typeof createReviewCommentStore>;
  updating: boolean;
  model: RenderModel;
  step: RenderStep;
  hover: ReturnType<typeof createCommentHover>;
  open: (target: ReviewCommentTarget, comment?: ReviewComment, rect?: AnchorRect, anchorId?: string) => void;
  beginCodeComment: (target: Extract<ReviewCommentTarget, { kind: "line" }>) => void;
  updateCodeComment: (id: string, body: string) => void;
  removeCodeComment: (id: string) => void;
  flushCodeComments: () => void;
  updateSummary: (summary: string) => void;
  save: (comments: ReviewComment[], summary: string) => Promise<DraftState>;
  publish: () => Promise<void>;
  renderMarkdown: (source: string) => ReactNode;
  getCommentBody: (id: string) => string;
  getSummary: () => string;
  closeEditor: () => void;
  saveEditor: (editor: CommentEditor, remove: boolean) => Promise<void>;
}

const CommentsContext = createContext<ReviewCommentActions | null>(null);
const emptyStore = createReviewCommentStore();
export function useReviewActions() { return useContext(CommentsContext); }

export function useReviewSelection<T>(select: (snapshot: ReviewCommentSnapshot) => T, equal: (a: T, b: T) => boolean): T {
  const context = useReviewActions();
  const store = context?.store ?? emptyStore;
  const committed = useRef<{ value: T } | null>(null);
  const selection = useMemo(() => createReviewSelection(store, select, equal, committed.current), [store, select, equal]);
  const value = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getServerSnapshot);
  useEffect(() => { committed.current = { value }; }, [value]);
  return value;
}

function draftLocked(state: DraftState | null) {
  return Boolean(state?.draft.githubReviewId || state?.draft.publishedAt || state?.draft.publishing);
}
function pinnedAnchor(snapshot: ReviewCommentSnapshot) {
  const editor = snapshot.editor;
  return editor && !snapshot.state?.draft.comments.some((comment) => comment.id === editor.id && comment.body.trim()) ? editor.anchorId ?? null : null;
}
export function useReviewLocked() {
  const context = useReviewActions();
  const locked = useReviewSelection((snapshot) => draftLocked(snapshot.state), Object.is);
  return Boolean(context?.updating || locked);
}
export function useReviewComments() {
  const context = useReviewActions();
  const snapshot = useReviewSelection((snapshot) => snapshot, Object.is);
  return context ? { ...context, ...snapshot, locked: context.updating || draftLocked(snapshot.state), pinnedAnchor: pinnedAnchor(snapshot) } : null;
}


export function ReviewCommentsProvider({ model, reviewId, step, children, renderMarkdown, updating = false, disabled = false }: {
  model: RenderModel; reviewId: string; step: RenderStep; children: ReactNode; renderMarkdown: (source: string) => ReactNode; updating?: boolean; disabled?: boolean;
}) {
  const [store] = useState(createReviewCommentStore);
  const setState = (state: DraftState | null) => store.update({ state });
  const setSaving = (saving: boolean) => store.update({ saving });
  const setError = (error: string | null) => store.update({ error });
  const notify = useToast();
  const setEditor = (change: CommentEditor | null | ((editor: CommentEditor | null) => CommentEditor | null)) => {
    store.update({ editor: typeof change === "function" ? change(store.getSnapshot().editor) : change });
  };
  const [hover] = useState(createCommentHover);
  const current = useRef<DraftState | null>(null);
  const version = useRef(0);
  const revision = useRef(0);
  const persistedRevision = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const autosave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const endpoint = `/api/service/reviews/${encodeURIComponent(reviewId)}/draft`;
  const githubMetadata = useCachedGitHubPullRequestMetadata(reviewId);
  const enabled = Boolean(!disabled && model.source.github && (githubMetadata?.state === "open" || githubMetadata?.state === "draft"));
  const isLocked = () => updating || draftLocked(current.current);

  useEffect(() => {
    hover.clear();
    if (!enabled) return;
    window.addEventListener("scroll", hover.clear, true);
    return () => {
      window.removeEventListener("scroll", hover.clear, true);
      hover.clear();
    };
  }, [enabled, hover, step.id]);

  useEffect(() => {
    // Drafts are unavailable during ingestion; resume loading when the update finishes.
    if (!enabled || updating) return;
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load review comments.");
      current.current = result; version.current = result.draft.version; setState(result);
    }).catch((error) => {
      if (!controller.signal.aborted) { const message = error instanceof Error ? error.message : String(error); setError(message); notify(message); }
    });
    return () => controller.abort();
  }, [enabled, endpoint, notify, updating]);

  const reportError = (message: string) => {
    setError(message);
    notify(message, revision.current > persistedRevision.current ? { action: { label: "Retry saving", onClick: () => { void persist().catch(() => {}); } } } : undefined);
  };

  const stage = (comments: ReviewComment[], summary: string, summaryIsCombined: boolean | undefined, refreshSharedState: boolean) => {
    if (!current.current) throw new Error("The review is still loading.");
    if (summaryIsCombined && summary === current.current.draft.summary) {
      summary = reconcileSummary(summary, current.current.draft.comments, comments, model.steps);
    }
    revision.current += 1;
    const next = { ...current.current, draft: { ...current.current.draft, comments, summary, summaryIsCombined } };
    current.current = next;
    // Inputs keep typing local while the current draft retains every edit.
    if (refreshSharedState) setState(next);
    setSaving(true);
  };

  const persist = (): Promise<DraftState> => {
    if (autosave.current) { clearTimeout(autosave.current); autosave.current = null; }
    setState(current.current);
    const requested = revision.current;
    const task = queue.current.catch(() => {}).then(async () => {
      if (!current.current) throw new Error("The review is still loading.");
      if (persistedRevision.current >= requested) return current.current;
      const snapshot = current.current;
      const savingRevision = revision.current;
      setError(null);
      try {
        const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: version.current, summary: snapshot.draft.summary, summaryIsCombined: snapshot.draft.summaryIsCombined,
            comments: snapshot.draft.comments.filter((comment) => comment.body.trim()) }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not save the comment.");
        version.current = result.draft.version;
        persistedRevision.current = savingRevision;
        // Keep newer typing and empty inline editors while refreshing the server preview.
        const next = { ...result, draft: { ...result.draft, comments: current.current.draft.comments, summary: current.current.draft.summary, summaryIsCombined: current.current.draft.summaryIsCombined } };
        current.current = next;
        setState(next);
        if (savingRevision === revision.current) setSaving(false);
        return next;
      } catch (error) {
        reportError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    queue.current = task;
    return task;
  };

  const save = (comments: ReviewComment[], summary: string): Promise<DraftState> => {
    stage(comments, summary, current.current?.draft.summaryIsCombined, true);
    return persist();
  };

  const scheduleSave = () => {
    if (autosave.current) clearTimeout(autosave.current);
    autosave.current = setTimeout(() => { void persist().catch(() => {}); }, 350);
  };

  const updateCodeComment = (id: string, body: string) => {
    if (!current.current || isLocked()) return;
    const draft = current.current.draft;
    const previous = draft.comments.find((comment) => comment.id === id);
    if (!previous || previous.body === body) return;
    const comments = draft.comments.map((comment) => comment.id === id ? { ...comment, body } : comment);
    stage(comments, draft.summary, draft.summaryIsCombined, Boolean(previous.body.trim()) !== Boolean(body.trim()));
    scheduleSave();
  };

  const editCodeComments = (change: (comments: ReviewComment[]) => ReviewComment[]) => {
    if (!current.current || isLocked()) return;
    stage(change(current.current.draft.comments), current.current.draft.summary, current.current.draft.summaryIsCombined, true);
    scheduleSave();
  };

  const beginCodeComment = (target: Extract<ReviewCommentTarget, { kind: "line" }>) => {
    if (!current.current || isLocked()) return;
    const merged = mergeCodeComments(current.current.draft.comments, target, crypto.randomUUID());
    editCodeComments(() => merged.comments);
    store.update({ focusedComment: { id: merged.id, sequence: (store.getSnapshot().focusedComment?.sequence ?? 0) + 1 } });
  };

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (revision.current > persistedRevision.current) { event.preventDefault(); }
    };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); if (autosave.current) clearTimeout(autosave.current); };
  }, []);

  const publish = async () => {
    const state = current.current;
    if (!state || busy.current || revision.current > persistedRevision.current) return;
    // Open during the click so the browser does not block the eventual GitHub tab.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: state.draft.version }) });
      const accepted = await response.json();
      if (!response.ok) throw new Error(accepted.error ?? "Could not publish draft comments.");
      let result;
      while (true) {
        const update = await fetch(`/api/service/jobs/${encodeURIComponent(accepted.jobId)}`, { cache: "no-store" });
        const job = await update.json();
        if (!update.ok || (job.status === "failed" || job.status === "cancelled")) throw new Error(job.error ?? "Publication was interrupted. Reload and retry.");
        if (job.status === "ready") { result = job.result; break; }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      current.current = result; setState(result);
      if (tab && result.draft.githubUrl) tab.location.href = result.draft.githubUrl;
    } catch (error) {
      tab?.close();
      reportError(error instanceof Error ? error.message : String(error));
      // A partially published draft remains recoverable on the next attempt.
      const response = await fetch(endpoint).catch(() => null);
      if (response?.ok) { const refreshed = await response.json(); current.current = refreshed; setState(refreshed); }
    } finally { busy.current = false; setSaving(false); }
  };

  const open = (target: ReviewCommentTarget, comment?: ReviewComment, rect?: AnchorRect, anchorId?: string) => {
    if (!current.current || isLocked()) return;
    const width = Math.min(360, window.innerWidth - 32);
    const height = target.kind === "quote" ? 160 : 96;
    const bounds = rect ?? document.activeElement?.getBoundingClientRect();
    let x = window.innerWidth - width - 20;
    let y = 100;
    if (bounds) {
      if (bounds.right + width + 16 < window.innerWidth) x = bounds.right + 8;
      else if (bounds.left - width - 8 > 16) x = bounds.left - width - 8;
      else { x = Math.max(16, Math.min(bounds.left, window.innerWidth - width - 16)); }
      y = Math.max(16, Math.min(bounds.top - 6, window.innerHeight - height - 16));
      if (x < bounds.right && x + width > bounds.left) y = bounds.top > height + 16 ? bounds.top - height - 12 : bounds.bottom + 12;
    }
    setEditor({ id: comment?.id ?? crypto.randomUUID(), target, body: comment?.body ?? "", anchorId, position: { x, y: Math.max(16, Math.min(y, window.innerHeight - height - 16)) } });
  };

  if (!enabled) return children;
  return <CommentsContext.Provider value={{ model, step, store, updating, hover, open, beginCodeComment,
    updateCodeComment,
    removeCodeComment: (id) => editCodeComments((comments) => comments.filter((comment) => comment.id !== id)),
    updateSummary: (summary) => {
      if (!current.current || isLocked()) return;
      stage(current.current.draft.comments, summary, true, false);
      scheduleSave();
    },
    getCommentBody: (id) => current.current?.draft.comments.find((comment) => comment.id === id)?.body ?? "",
    getSummary: () => current.current?.draft.summaryIsCombined ? current.current.draft.summary : current.current?.preview.body ?? "",
    closeEditor: () => setEditor(null),
    saveEditor: async (editor, remove) => {
      const latest = current.current;
      if (!latest || isLocked()) return;
      const exists = latest.draft.comments.some((comment) => comment.id === editor.id);
      const comment = { id: editor.id, target: editor.target, body: editor.body.trim() };
      const comments = remove ? latest.draft.comments.filter((c) => c.id !== editor.id)
        : exists ? latest.draft.comments.map((c) => c.id === editor.id ? comment : c) : [...latest.draft.comments, comment];
      await save(comments, latest.draft.summary);
      setEditor((active) => active?.id === editor.id ? null : active);
    },
    flushCodeComments: () => { void persist().catch(() => {}); }, save, publish, renderMarkdown }}>
    {children}
    <CommentDialogHost />
  </CommentsContext.Provider>;
}

function CommentDialogHost() {
  const context = useReviewActions()!;
  const editor = useReviewSelection((snapshot) => snapshot.editor, Object.is);
  return editor ? <CommentDialog key={editor.id} initialEditor={editor} onClose={context.closeEditor} onSave={context.saveEditor} /> : null;
}

function CommentDialog({ initialEditor, onClose, onSave }: {
  initialEditor: CommentEditor; onClose: () => void; onSave: (editor: CommentEditor, remove: boolean) => Promise<void>;
}) {
  const [editor, setEditor] = useState(initialEditor);
  const savedComment = useReviewSelection((snapshot) => snapshot.state?.draft.comments.find((comment) => comment.id === initialEditor.id), Object.is);
  const input = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submit = async (remove: boolean) => {
    if (submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true);
    try { await onSave({ ...editor, body: input.current?.value ?? editor.body }, remove); } finally { submittingRef.current = false; setSubmitting(false); }
  };
  const dialog = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => { dialog.current?.querySelector("textarea")?.focus(); }, []);
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      if (submitting || !(event.target instanceof Node) || dialog.current?.contains(event.target)) return;
      const body = input.current?.value.trim() ?? "";
      if (body) {
        if (savedComment?.body === body) onClose();
        else void submit(false).catch(() => {});
      } else onClose();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [submitting, savedComment, onClose, submit]);
  const save = (remove: boolean) => { void submit(remove).catch(() => {}); };
  const target = editor.target;
  const existing = Boolean(savedComment);
  return <div className="comment-dialog" ref={dialog} role="dialog" aria-label={target.kind === "line" ? "Code comment" : "Review comment"} style={{ left: editor.position.x, top: editor.position.y }} onKeyDown={(event) => { if (event.key === "Escape" && !submitting) onClose(); }}>
    <div className="code-comment-heading"><div className="comment-drag-handle" title="Drag to move" onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault(); drag.current = { x: event.clientX, y: event.clientY, left: editor.position.x, top: editor.position.y }; event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => {
      if (!drag.current) return;
      const rect = dialog.current!.getBoundingClientRect();
      setEditor({ ...editor, position: { x: Math.max(8, Math.min(window.innerWidth - rect.width - 8, drag.current.left + event.clientX - drag.current.x)), y: Math.max(8, Math.min(window.innerHeight - rect.height - 8, drag.current.top + event.clientY - drag.current.y)) } });
    }} onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }}>
      <GripHorizontal size={12} /><strong>Draft comment</strong></div>
      <button className="comment-save" aria-label="Save comment" title="Save and dismiss" disabled={submitting} onClick={() => input.current?.value.trim() ? save(false) : onClose()}><Check size={14} /></button>
      <button aria-label="Remove comment" title="Remove comment" disabled={submitting} onClick={() => existing ? save(true) : onClose()}><X size={14} /></button></div>
    {target.kind === "quote" && <blockquote className="comment-quote">{target.quote}</blockquote>}
    <div className="compact-comment-row"><textarea ref={input} aria-label="Comment" placeholder="Add a comment…" rows={2} defaultValue={initialEditor.body} disabled={submitting} title="Enter to save. Shift+Enter for a new line."
      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); const body = event.currentTarget.value.trim(); if ((body || existing) && !submitting) save(!body); } }} />
    </div>
  </div>;
}

export function CommentAnchor({ target, children, inline = false, centered = false }: { target: ReviewCommentTarget; children: ReactNode; inline?: boolean; centered?: boolean }) {
  const context = useReviewActions();
  const locked = useReviewLocked();
  const loaded = useReviewSelection((snapshot) => Boolean(snapshot.state), Object.is);
  const pinned = useReviewSelection(pinnedAnchor, Object.is);
  const saved = useReviewSelection((snapshot) => snapshot.state?.draft.comments.filter((comment) => comment.target.stepId === target.stepId && comment.target.anchor === target.anchor) ?? [], sameItems);
  const instanceId = useId();
  const anchor = useRef<HTMLDivElement & HTMLSpanElement>(null);
  const [gutter, setGutter] = useState(-27);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const container = element.closest(".step-content, .detail-panel-content");
    if (!container) return;
    const place = () => {
      const padding = parseFloat(getComputedStyle(container).paddingLeft);
      setGutter(container.getBoundingClientRect().left + Math.max(2, padding - 30) + 3 - element.getBoundingClientRect().left);
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(container); observer.observe(element);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [context?.step.id]);
  if (!context) return children;
  const hasComments = saved.some((comment) => comment.body.trim());
  const Tag = inline ? "span" : "div";
  return <Tag ref={anchor} className={`comment-anchor${inline ? " comment-anchor-inline" : ""}${centered ? " comment-anchor-centered" : ""}`}
    onPointerMove={(event) => {
      event.stopPropagation();
      // Scrolling beneath a stationary pointer must not reveal another temporary icon.
      if (event.movementX || event.movementY) context.hover.show(hasComments ? null : instanceId);
    }}
    onFocus={(event) => { event.stopPropagation(); context.hover.show(hasComments ? null : instanceId); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) context.hover.leave(instanceId); }}
    onMouseLeave={() => context.hover.leave(instanceId)}>
    <span className="comment-gutter" aria-hidden="true" style={{ left: gutter - 3 }} />
    <CommentBubbles context={context} target={target} saved={saved} instanceId={instanceId} gutter={gutter} locked={locked} loaded={loaded} pinned={pinned} />
    {children}
  </Tag>;
}

function CommentBubbles({ context, target, saved, instanceId, gutter, locked, loaded, pinned }: {
  context: ReviewCommentActions; locked: boolean; loaded: boolean; pinned: string | null; target: ReviewCommentTarget; saved: ReviewComment[]; instanceId: string; gutter: number;
}) {
  const subscribe = useCallback((listener: () => void) => context.hover.subscribe(instanceId, listener), [context.hover, instanceId]);
  const hovered = useSyncExternalStore(subscribe,
    () => pinned !== null ? pinned === instanceId : context.hover.isActive(instanceId),
    () => false);
  const [dismissedPreview, setDismissedPreview] = useState<string | null>(null);
  const hasComments = saved.some((comment) => comment.body.trim());
  return <span className={`comment-bubbles${hasComments ? " has-comments" : ""}${hovered ? " is-hovered" : ""}`} style={{ left: gutter }}>{(saved.length ? saved : [null]).map((comment) => <span className="comment-bubble-wrap" key={comment?.id ?? "new"} onMouseLeave={() => setDismissedPreview(null)}>
      <button className={`comment-bubble${comment?.body.trim() ? " comment-bubble-filled" : ""}`} aria-label={comment ? "Edit review comment" : "Add review comment"}
        disabled={!loaded || locked} onClick={(event) => { event.stopPropagation(); context.open(comment?.target ?? target, comment ?? undefined, event.currentTarget.getBoundingClientRect(), instanceId); }}><MessageSquare size={15} /></button>
      {comment?.body && dismissedPreview !== comment.id && <span className="comment-hover" role="tooltip">
        <span className="code-comment-heading"><MessageSquare size={13} /><strong>Draft comment</strong>
          <button className="comment-save" aria-label="Dismiss comment preview" onClick={(event) => { event.stopPropagation(); setDismissedPreview(comment.id); }}><Check size={14} /></button>
          <button aria-label="Remove comment" disabled={locked} onClick={(event) => { event.stopPropagation(); context.removeCodeComment(comment.id); }}><X size={14} /></button>
        </span><span className="compact-comment-text" onClick={(event) => { event.stopPropagation(); context.open(comment.target, comment, event.currentTarget.closest(".comment-bubble-wrap")?.getBoundingClientRect(), instanceId); }}>{comment.body}</span>
      </span>}
    </span>)}</span>;
}

export function AnnotatedMarkdown({ anchor, section, children }: { anchor: string; section?: string; children: ReactNode }) {
  const context = useReviewActions();
  if (!context) return children;
  return <CommentAnchor target={{ kind: "section", stepId: context.step.id, anchor, section: section ?? context.step.title }}>{children}</CommentAnchor>;
}

export function reconcileSummary(summary: string, previous: ReviewComment[], next: ReviewComment[], steps: RenderStep[]): string {
  const narrative = (comment: ReviewComment) => comment.target.kind === "section" || comment.target.kind === "quote";
  for (const comment of previous.filter(narrative)) {
    const updated = next.find((candidate) => candidate.id === comment.id && narrative(candidate));
    if (updated?.body === comment.body) continue;
    // Only replace complete comment paragraphs, preserving edits authored in the combined summary.
    const padded = `\n\n${summary}\n\n`;
    const block = `\n\n${comment.body.trim()}\n\n`;
    if (padded.includes(block)) summary = padded.replace(block, `\n\n${updated?.body.trim() ?? ""}\n\n`).trim();
  }
  for (const comment of next.filter(narrative)) {
    const old = previous.find((candidate) => candidate.id === comment.id && narrative(candidate));
    if (old?.body === comment.body || summary.includes(comment.body.trim())) continue;
    if (old && !comment.body.trim()) continue;
    const step = steps.find((step) => step.id === comment.target.stepId);
    const section = "section" in comment.target ? comment.target.section : "";
    const heading = `## ${step?.title ?? "Review"}${section && section !== step?.title ? `\n\n### ${section}` : ""}`;
    summary = `${summary.trim()}\n\n${heading}\n\n${comment.body.trim()}`.trim();
  }
  return summary;
}

export function mergeCodeComments(comments: ReviewComment[], target: Extract<ReviewCommentTarget, { kind: "line" }>, newId: string): { comments: ReviewComment[]; id: string } {
  const overlaps = comments.filter((comment) => comment.target.kind === "line" && comment.target.stepId === target.stepId
    && comment.target.path === target.path && comment.target.side === target.side
    && comment.target.startLine <= target.endLine && target.startLine <= comment.target.endLine);
  overlaps.sort((a, b) => (a.target.kind === "line" ? a.target.startLine : 0) - (b.target.kind === "line" ? b.target.startLine : 0));
  const id = overlaps[0]?.id ?? newId;
  const removed = new Set(overlaps.map((comment) => comment.id));
  const comment: ReviewComment = { id, target, body: overlaps.map((comment) => comment.body.trim()).filter(Boolean).join("\n\n") };
  return { id, comments: [...comments.filter((comment) => !removed.has(comment.id)), comment] };
}

function DraftInput({ getValue, subscribe, onChange, onBlur, disabled, label, placeholder, className, minHeight, focusSequence }: {
  getValue: () => string; subscribe: (listener: () => void) => () => void;
  onChange: (body: string) => void; onBlur: () => void; disabled: boolean;
  label: string; placeholder: string; className: string; minHeight: number; focusSequence: number | null;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const sync = () => {
      const element = input.current;
      const value = getValue();
      if (element && element.value !== value) element.value = value;
    };
    sync();
    return subscribe(sync);
  }, [getValue, subscribe]);
  useEffect(() => {
    if (focusSequence !== null) input.current?.focus({ preventScroll: true });
  }, [focusSequence]);
  return <textarea ref={input} className={className} aria-label={label} placeholder={placeholder} defaultValue={getValue()} disabled={disabled}
    style={{ minHeight, fieldSizing: "content" }} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} />;
}

export function CodeCommentBlock({ commentId, autofocus = true }: { commentId: string; autofocus?: boolean }) {
  const context = useReviewActions();
  const locked = useReviewLocked();
  const focusSequence = useReviewSelection((snapshot) => autofocus && snapshot.focusedComment?.id === commentId ? snapshot.focusedComment.sequence : null, Object.is);
  const getValue = useCallback(() => context?.getCommentBody(commentId) ?? "", [context, commentId]);
  if (!context) return null;
  return <div className="code-comment-block"><div className="code-comment-heading"><MessageSquare size={13} /><strong>Draft comment</strong>
    <button aria-label="Remove code comment" title="Remove comment" disabled={locked} onClick={() => context.removeCodeComment(commentId)}><X size={14} /></button></div>
    <DraftInput label="Code comment" placeholder="Add a comment…" getValue={getValue} subscribe={context.store.subscribe} disabled={locked}
      className="" minHeight={50} focusSequence={focusSequence}
      onChange={(body) => context.updateCodeComment(commentId, body)} onBlur={context.flushCodeComments} />
  </div>;
}

export function FinalReview({ renderThread }: { renderThread: (comment: ReviewComment) => ReactNode }) {
  const context = useReviewComments()!;
  const state = context.state;
  const summary = state?.draft.summaryIsCombined ? state.draft.summary : state?.preview.body ?? "";
  const headerStart = useRef<HTMLDivElement>(null);
  const [headerStuck, setHeaderStuck] = useState(false);
  const loaded = Boolean(state);
  useEffect(() => {
    const marker = headerStart.current;
    const container = marker?.closest(".step-content");
    if (!marker || !container) return;
    const update = () => setHeaderStuck(marker.getBoundingClientRect().top <= container.getBoundingClientRect().top);
    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { container.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [loaded]);
  if (!state) return <div className="draft-review"><header className="draft-review-header"><h1><GitHubIcon size={30} />GitHub review</h1></header><p>{context.error ? "Unable to load your draft." : "Loading your draft…"}</p></div>;
  return <div className="draft-review"><div ref={headerStart} aria-hidden="true" /><header className={`draft-review-header${headerStuck ? " is-sticky" : ""}`}><h1><GitHubIcon size={30} />GitHub review</h1>
    <div className="draft-review-actions">
      {state.draft.githubUrl && <a href={state.draft.githubUrl} target="_blank" rel="noreferrer">Open GitHub review <ExternalLink size={14} /></a>}
      {!state.draft.publishedAt && <button className="draft-primary" disabled={context.saving || state.draft.publishing || Boolean(state.preview.errors.length) || (!summary.trim() && !state.preview.threads.length)} onClick={() => { void context.publish(); }}><Send size={15} />{context.saving ? "Saving…" : "Publish draft comments"}</button>}
    </div>
    </header>
    <DraftInput className="draft-summary-input" label="Review summary" placeholder="Write your review summary…" getValue={context.getSummary} subscribe={context.store.subscribe}
      minHeight={140} focusSequence={null} disabled={context.locked} onChange={context.updateSummary} onBlur={context.flushCodeComments} />
    <div className="draft-threads">
      {state.draft.comments.filter((comment) => comment.target.kind === "file" || comment.target.kind === "line").map((comment) => {
        const thread = state.preview.threads.find((thread) => thread.commentId === comment.id);
        return <article className="draft-thread" key={comment.id}>
          {renderThread(comment)}
          {thread?.error && <div className="draft-error"><p>{thread.error}</p><button disabled={context.locked || context.saving} onClick={() => {
            const target: ReviewCommentTarget = comment.target.kind === "line" && context.model.source.files?.some((file) => file.path === thread.path)
              ? { kind: "file", stepId: comment.target.stepId, anchor: `file:${thread.path}`, path: thread.path }
              : { kind: "section", stepId: comment.target.stepId, anchor: "section", section: context.model.steps.find((s) => s.id === comment.target.stepId)?.title ?? "Review" };
            void context.save(state.draft.comments.map((c) => c.id === comment.id ? { ...c, target } : c), state.draft.summary).catch(() => {});
          }}>Move to {comment.target.kind === "line" && context.model.source.files?.some((file) => file.path === thread.path) ? "file comment" : "step summary"}</button></div>}
        </article>;
      })}
    </div>
    <ToastMessage message={state.preview.errors.length ? `Resolve the comment locations before publishing. ${state.preview.errors.join(" ")}` : null} />

  </div>;
}
