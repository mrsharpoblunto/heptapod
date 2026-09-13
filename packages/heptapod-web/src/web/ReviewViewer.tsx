"use client";

import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ExternalLink,
  FoldVertical,
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  UnfoldVertical,
  X,
} from "lucide-react";
import {
  createContext,
  memo,
  Fragment,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type ElementType,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import hljs from "highlight.js/lib/common";
import type {
  Callsite,
  Check,
  Evidence,
  PatchFile,
  RenderModel,
  RenderStep,
  ReviewComment,
  ParsedTestCaseChange,
  TestFixtureRun,
  TestCaseChangeKind,
} from "@thestraylight/heptapod-core/types";
import { patchRename } from "@thestraylight/heptapod-core/patch";
import {
  GitHubIcon,
  useCachedGitHubPullRequestMetadata,
} from "./GitHubIdentity";
import { codeCommentLocations, sameCommentLocations } from "./review-comment-store";
import { ReviewHeader } from "./ReviewHeader";
import { ReviewProgress, type ReviewStatus } from "./ReviewProgress";
import { AnnotatedMarkdown, CodeCommentBlock, CommentAnchor, FinalReview, ReviewCommentsProvider, useReviewComments, useReviewActions, useReviewSelection, useReviewLocked } from "./ReviewComments";

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function statusLabel(status: Check["status"]): string {
  return {
    passing: "Passing",
    failing: "Failing",
    "not-run": "Not run",
    blocked: "Blocked",
    "not-applicable": "N/A",
  }[status] ?? status;
}

function kindLabel(kind: RenderStep["kind"]): string {
  return { description: "Context", tests: "Tests", refactor: "Refactor", implementation: "Implementation", manual: "Tests" }[kind];
}

const ReviewRuntimeContext = createContext<{ reviewId?: string }>({});

function languageForFile(path?: string): string | undefined {
  const extension = path?.split(".").at(-1)?.toLowerCase();
  return {
    c: "c", cc: "cpp", cjs: "javascript", cpp: "cpp", cs: "csharp", css: "css", go: "go",
    gql: "graphql", graphql: "graphql", h: "cpp", htm: "xml", html: "xml", java: "java",
    js: "javascript", jsx: "javascript", json: "json", kt: "kotlin", less: "less", lua: "lua",
    md: "markdown", mjs: "javascript", php: "php", py: "python", rb: "ruby", rs: "rust",
    scss: "scss", sh: "bash", sql: "sql", swift: "swift", ts: "typescript", tsx: "typescript",
    xml: "xml", yaml: "yaml", yml: "yaml", zsh: "bash",
  }[extension ?? ""];
}

function highlightedHtml(source: string, language?: string): string {
  if (!source) return "";
  try {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(source, { language }).value
      : hljs.highlightAuto(source).value;
  } catch {
    return source
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
}

const HighlightedDiffCode = memo(function HighlightedDiffCode({ content, language }: { content: string; language: string | undefined }) {
  return <span className="hljs" dangerouslySetInnerHTML={{ __html: highlightedHtml(content, language) }} />;
});

function HighlightedCode({ source, language }: { source: string; language?: string }): ReactNode {
  return <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedHtml(source, language) }} />;
}

function Inline({
  text,
  files,
  onSelectFile,
  annotatable = true,
}: {
  text: string;
  files: PatchFile[];
  onSelectFile?: (file: string) => void;
  annotatable?: boolean;
}): ReactNode {
  const pattern = /(!?\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
  const parts = String(text).split(pattern);
  return parts.map((part, index) => {
    let match = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (match) return <img className="markdown-image" src={match[2]} alt={match[1]} key={index} />;
    match = part.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
    if (match) {
      const referencePrefix = "heptapod-file:";
      const path = match[2].startsWith(referencePrefix)
        ? decodeURIComponent(match[2].slice(referencePrefix.length))
        : null;
      const file = path ? files.find((candidate) => candidate.path === path) : undefined;
      if (file && onSelectFile) {
        return <FileLink file={file.path} active={false} inline annotatable={annotatable} onSelect={onSelectFile} key={index} />;
      }
      return <a href={match[2]} target="_blank" rel="noreferrer" key={index}>{match[1]}</a>;
    }
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function Markdown({
  source,
  files = [],
  onSelectFile,
  annotationKey,
  section,
  annotatable = true,
}: {
  source: string;
  files?: PatchFile[];
  onSelectFile?: (file: string) => void;
  annotationKey?: string;
  section?: string;
  annotatable?: boolean;
}): ReactNode {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  const sections: Array<{ start: number; title?: string }> = [{ start: 0, title: section }];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      index += 1;
      blocks.push(<pre className="code-block" key={blocks.length} data-language={language || undefined}><HighlightedCode source={code.join("\n")} language={language || undefined} /></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      if (!blocks.length) sections[0].title = heading[2];
      else sections.push({ start: blocks.length, title: heading[2] });
      const Tag = `h${Math.min(heading[1].length + 1, 5)}` as ElementType;
      blocks.push(<Tag key={blocks.length}><Inline text={heading[2]} files={files} onSelectFile={onSelectFile} annotatable={annotatable} /></Tag>);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^[-*]\s+/, ""));
      blocks.push(<ul key={blocks.length}>{items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item} files={files} onSelectFile={onSelectFile} annotatable={annotatable} /></li>)}</ul>);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) items.push(lines[index++].replace(/^\d+\.\s+/, ""));
      blocks.push(<ol key={blocks.length}>{items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item} files={files} onSelectFile={onSelectFile} annotatable={annotatable} /></li>)}</ol>);
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith("> ")) quote.push(lines[index++].slice(2));
      blocks.push(<blockquote key={blocks.length}><Inline text={quote.join(" ")} files={files} onSelectFile={onSelectFile} annotatable={annotatable} /></blockquote>);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s|^```|^[-*]\s+|^\d+\.\s+|^>\s+/.test(lines[index])) {
      paragraph.push(lines[index++].trim());
    }
    blocks.push(<p key={blocks.length}><Inline text={paragraph.join(" ")} files={files} onSelectFile={onSelectFile} annotatable={annotatable} /></p>);
  }
  const key = annotationKey ?? `markdown:${Array.from(source).reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)}`;
  return <div className="markdown">{annotatable ? sections.filter((group) => group.start < blocks.length).map((group, index) =>
    <AnnotatedMarkdown key={index} anchor={`${key}:${index}`} section={group.title}>{blocks.slice(group.start, sections[index + 1]?.start)}</AnnotatedMarkdown>) : blocks}</div>;
}

function EvidenceGallery({ evidence }: { evidence: Evidence[] }): ReactNode {
  const { reviewId } = useContext(ReviewRuntimeContext);
  if (evidence.length === 0) return null;
  return <div className="evidence-grid">{evidence.map((item) => {
    const assetId = item.url.match(/^https:\/\/(?:github\.com\/user-attachments\/assets\/|(?:private-user-images|user-images)\.githubusercontent\.com\/).*?([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})/i)?.[1];
    const mediaUrl = reviewId && assetId
      ? `/api/reviews/${encodeURIComponent(reviewId)}/github-media/${assetId}`
      : item.url;
    if (item.kind === "image") return <a href={item.sourceUrl ?? item.url} target="_blank" rel="noreferrer" key={item.url}>
      <img src={mediaUrl} alt={item.label} />
    </a>;
    if (item.kind === "video") {
      return <figure className="evidence-video" key={item.url}>
        <video controls playsInline preload="metadata" src={mediaUrl}>
          <a href={item.url}>Open video evidence</a>
        </video>
        <figcaption><a href={item.sourceUrl ?? item.url} target="_blank" rel="noreferrer">{item.label}</a></figcaption>
      </figure>;
    }
    return <a className="evidence-link" href={item.url} target="_blank" rel="noreferrer" key={item.url}>
      <ExternalLink aria-hidden="true" size={14} />
      <span>{item.label}</span>
    </a>;
  })}</div>;
}

interface DiffLine {
  content: string;
  type: "hunk" | "add" | "del" | "context" | "meta";
  old: number | null;
  next: number | null;
  key: number;
  oldStart?: number;
  newStart?: number;
}

interface DiffTarget {
  oldLine?: number;
  oldEndLine?: number;
  newLine?: number;
  newEndLine?: number;
}

interface DiffGap {
  id: string;
  lines: DiffLine[];
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

type DiffSegment =
  | { kind: "lines"; id: string; lines: DiffLine[] }
  | { kind: "gap"; gap: DiffGap };

export function parseDiff(patch: string): DiffLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return patch.replace(/\n$/, "").split("\n").map((content, index) => {
    const hunk = content.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { content, type: "hunk", old: null, next: null, key: index, oldStart: oldLine, newStart: newLine };
    }
    if (oldLine !== null && newLine !== null && content.startsWith("+") && !content.startsWith("+++")) {
      return { content, type: "add", old: null, next: newLine++, key: index };
    }
    if (oldLine !== null && content.startsWith("-") && !content.startsWith("---")) {
      return { content, type: "del", old: oldLine++, next: null, key: index };
    }
    if (oldLine !== null && newLine !== null && content.startsWith(" ")) {
      return { content, type: "context", old: oldLine++, next: newLine++, key: index };
    }
    return { content, type: "meta", old: null, next: null, key: index };
  });
}

function sourceLines(source?: string | null): string[] {
  if (!source) return [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function buildDiffSegments(
  lines: DiffLine[],
  beforeContent?: string | null,
  afterContent?: string | null,
): DiffSegment[] {
  const after = sourceLines(afterContent);
  if (after.length > 0 && lines.every((line) => line.content === "")) {
    return [{
      kind: "lines",
      id: "snapshot",
      lines: after.map((content, index) => ({
        content: ` ${content}`,
        type: "context",
        old: index + 1,
        next: index + 1,
        key: index,
      })),
    }];
  }
  if (after.length === 0 || !lines.some((line) => line.type === "hunk")) {
    return [{ kind: "lines", id: "patch", lines }];
  }

  const before = sourceLines(beforeContent);
  const hunks: DiffLine[][] = [];
  for (const line of lines) {
    if (line.type === "hunk") hunks.push([line]);
    else hunks.at(-1)?.push(line);
  }

  const segments: DiffSegment[] = [];
  let oldCursor = 1;
  let newCursor = 1;
  let generatedKey = -1;
  const addGap = (oldStart: number, newStart: number, count: number) => {
    if (count <= 0) return;
    const gapLines = Array.from({ length: count }, (_, index): DiffLine => ({
      content: ` ${after[newStart + index - 1] ?? ""}`,
      type: "context",
      old: oldStart + index,
      next: newStart + index,
      key: generatedKey--,
    }));
    segments.push({
      kind: "gap",
      gap: {
        id: `${oldStart}-${newStart}-${count}`,
        lines: gapLines,
        oldStart,
        oldEnd: oldStart + count - 1,
        newStart,
        newEnd: newStart + count - 1,
      },
    });
  };

  for (const [index, hunk] of hunks.entries()) {
    const header = hunk[0];
    const oldStart = header.oldStart ?? oldCursor;
    const newStart = header.newStart ?? newCursor;
    addGap(oldCursor, newCursor, Math.min(oldStart - oldCursor, newStart - newCursor));
    segments.push({ kind: "lines", id: `hunk-${index}`, lines: hunk });
    oldCursor = oldStart;
    newCursor = newStart;
    for (const line of hunk) {
      if (line.old !== null) oldCursor = line.old + 1;
      if (line.next !== null) newCursor = line.next + 1;
    }
  }

  const oldRemaining = before.length > 0 ? before.length - oldCursor + 1 : after.length - newCursor + 1;
  addGap(oldCursor, newCursor, Math.min(oldRemaining, after.length - newCursor + 1));
  return segments;
}

export function DiffView(props: Parameters<typeof SourceDiffView>[0]): ReactNode {
  const rename = patchRename(props.patch);
  if (rename) return <div className="diff-shell moved-file">
    <div className="diff moved-file-content">file moved</div>
  </div>;
  return <MemoizedSourceDiffView {...props} />;
}

const MemoizedSourceDiffView = memo(SourceDiffView);

function SourceDiffView({
  filePath,
  patch,
  compact = false,
  scrollTarget,
  beforeContent,
  afterContent,
  githubFileUrl,
  commentStepId,
  snippetRange,
}: {
  filePath: string;
  patch: string;
  compact?: boolean;
  scrollTarget?: DiffTarget | null;
  beforeContent?: string | null;
  afterContent?: string | null;
  githubFileUrl?: string | null;
  commentStepId?: string;
  snippetRange?: { side: "LEFT" | "RIGHT"; startLine: number; endLine: number };
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const comments = useReviewActions();
  const locked = useReviewLocked();
  const annotationStep = commentStepId ?? comments?.step.id;
  const canComment = Boolean(!snippetRange && comments?.model.source.files?.some((file) => file.path === filePath) && !locked);
  const codeComments = useReviewSelection((snapshot) => snippetRange ? [] : codeCommentLocations(snapshot, annotationStep, filePath), sameCommentLocations);
  const [commentRange, setCommentRange] = useState<{ side: "LEFT" | "RIGHT"; start: number; end: number } | null>(null);
  const dragRange = useRef<typeof commentRange>(null);
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(() => new Set());
  const [fullFile, setFullFile] = useState(false);
  const language = languageForFile(filePath);
  const pureAddition = /^(?:new file mode |--- \/dev\/null$)/m.test(patch);
  const pureDeletion = /^(?:deleted file mode |\+\+\+ \/dev\/null$)/m.test(patch);
  const lines = useMemo(() => {
    const parsed = parseDiff(patch);
    const firstHunk = parsed.findIndex((line) => line.type === "hunk");
    return firstHunk === -1 ? parsed : parsed.slice(firstHunk);
  }, [patch]);
  const unchanged = !lines.some((line) => line.type === "add" || line.type === "del");
  const segments = useMemo(
    () => buildDiffSegments(lines, beforeContent, afterContent),
    [afterContent, beforeContent, lines],
  );
  const visibleLines = useMemo(() => segments.flatMap((segment) => {
    if (segment.kind === "lines") return segment.lines;
    return fullFile || expandedGaps.has(segment.gap.id) ? segment.gap.lines : [];
  }), [expandedGaps, fullFile, segments]);

  useEffect(() => {
    const finish = () => {
      const range = dragRange.current;
      dragRange.current = null;
      setCommentRange(null);
      if (!range || !comments) return;
      const startLine = Math.min(range.start, range.end);
      const endLine = Math.max(range.start, range.end);
      comments.beginCodeComment({ kind: "line", stepId: annotationStep!, anchor: `code:${filePath}:${range.side}:${startLine}-${endLine}`, path: filePath, side: range.side, startLine, endLine });
    };
    const cancel = () => { dragRange.current = null; setCommentRange(null); };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    return () => { window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); };
  }, [comments, filePath, annotationStep]);

  useEffect(() => {
    setExpandedGaps((current) => {
      const next = new Set(current);
      for (const segment of segments) {
        if (segment.kind !== "gap") continue;
        if (codeComments.some(({ target }) => target.kind === "line" && target.endLine >= (target.side === "LEFT" ? segment.gap.oldStart : segment.gap.newStart)
          && target.endLine <= (target.side === "LEFT" ? segment.gap.oldEnd : segment.gap.newEnd))) next.add(segment.gap.id);
      }
      return next.size === current.size ? current : next;
    });
  }, [codeComments, segments]);

  useEffect(() => {
    setExpandedGaps(new Set());
    setFullFile(false);
  }, [patch]);

  useEffect(() => {
    if (!scrollTarget) return;
    setExpandedGaps((current) => {
      const next = new Set(current);
      for (const segment of segments) {
        if (segment.kind !== "gap") continue;
        const overlapsNew = scrollTarget.newLine !== undefined
          && scrollTarget.newLine <= segment.gap.newEnd
          && (scrollTarget.newEndLine ?? scrollTarget.newLine) >= segment.gap.newStart;
        const overlapsOld = scrollTarget.oldLine !== undefined
          && scrollTarget.oldLine <= segment.gap.oldEnd
          && (scrollTarget.oldEndLine ?? scrollTarget.oldLine) >= segment.gap.oldStart;
        if (overlapsNew || overlapsOld) next.add(segment.gap.id);
      }
      return next.size === current.size ? current : next;
    });
  }, [scrollTarget, segments]);

  const targetMatch = useMemo(() => {
    const target = scrollTarget?.newLine !== undefined
      ? { side: "next" as const, start: scrollTarget.newLine, end: scrollTarget.newEndLine ?? scrollTarget.newLine }
      : scrollTarget?.oldLine !== undefined
        ? { side: "old" as const, start: scrollTarget.oldLine, end: scrollTarget.oldEndLine ?? scrollTarget.oldLine }
        : null;
    if (!target) return { keys: new Set<number>(), scrollKey: null };
    const candidates = visibleLines.filter((line) => line[target.side] !== null);
    const withinRange = candidates.filter((line) => {
      const number = line[target.side] ?? 0;
      return number >= target.start && number <= target.end;
    });
    const matched = withinRange.length > 0 ? withinRange : candidates.reduce<DiffLine[]>((nearest, line) => {
      if (nearest.length === 0) return [line];
      return Math.abs((line[target.side] ?? 0) - target.start) < Math.abs((nearest[0][target.side] ?? 0) - target.start)
        ? [line]
        : nearest;
    }, []);
    return { keys: new Set(matched.map((line) => line.key)), scrollKey: matched[0]?.key ?? null };
  }, [scrollTarget, visibleLines]);

  useEffect(() => {
    if (targetMatch.scrollKey === null) return;
    const target = containerRef.current?.querySelector<HTMLElement>(`[data-diff-key="${targetMatch.scrollKey}"]`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [scrollTarget, targetMatch]);

  const renderLine = (line: DiffLine): ReactNode => {
    if (line.type === "hunk") return null;
    const isCodeLine = line.type === "add" || line.type === "del" || line.type === "context";
    const omitMarker = (pureAddition && line.type === "add") || (pureDeletion && line.type === "del");
    const marker = isCodeLine && !omitMarker ? line.content.slice(0, 1) : "";
    const content = isCodeLine ? line.content.slice(1) : line.content;
    const lineNumber = (number: number | null, side: "LEFT" | "RIGHT") => canComment && number !== null
      ? <button className="line-number comment-line-number" aria-label={`Comment on ${side === "LEFT" ? "original" : "updated"} line ${number}`} title="Click or drag to comment" onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); dragRange.current = { side, start: number, end: number }; setCommentRange(dragRange.current);
      }} onPointerEnter={() => {
        if (dragRange.current?.side !== side) return;
        dragRange.current = { ...dragRange.current, end: number }; setCommentRange(dragRange.current);
      }} onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && comments) { event.preventDefault(); comments.beginCodeComment({ kind: "line", stepId: annotationStep!, anchor: `code:${filePath}:${side}:${number}`, path: filePath, side, startLine: number, endLine: number }); }
      }}>{number}</button>
      : <span className="line-number">{number ?? ""}</span>;
    const selectedRange = commentRange && (commentRange.side === "LEFT" ? line.old : line.next);
    const annotated = [...codeComments, ...(snippetRange ? [{ target: { kind: "line", ...snippetRange } }] : [])].some(({ target }) => target.kind === "line" && (target.side === "LEFT" ? line.old : line.next) !== null
      && (target.side === "LEFT" ? line.old! : line.next!) >= target.startLine && (target.side === "LEFT" ? line.old! : line.next!) <= target.endLine);
    const inSelection = selectedRange !== null && selectedRange !== undefined && commentRange && selectedRange >= Math.min(commentRange.start, commentRange.end) && selectedRange <= Math.max(commentRange.start, commentRange.end);
    return <Fragment key={line.key}><div className={classNames(`diff-line diff-${line.type}`, targetMatch.keys.has(line.key) && "diff-target", Boolean(inSelection || annotated) && "diff-comment-range")} data-diff-key={line.key}>
      {pureAddition || unchanged
        ? lineNumber(line.next, "RIGHT")
        : pureDeletion
          ? lineNumber(line.old, "LEFT")
          : <>{lineNumber(line.old, "LEFT")}{lineNumber(line.next, "RIGHT")}</>}
      <code>{marker && <span className="diff-marker">{marker}</span>}<HighlightedDiffCode content={content} language={language} /></code>
    </div>{codeComments.filter(({ target }) => target.kind === "line" && target.endLine === (target.side === "LEFT" ? line.old : line.next)).map((comment) => <CodeCommentBlock commentId={comment.id} key={comment.id} />)}</Fragment>;
  };
  const gaps = segments.filter((segment): segment is Extract<DiffSegment, { kind: "gap" }> => segment.kind === "gap");
  const globalActions = <div className="diff-global-actions">
    {gaps.length > 0 && <button onClick={() => {
      if (fullFile) {
        setFullFile(false);
        setExpandedGaps(new Set());
      } else {
        setFullFile(true);
      }
    }} title={fullFile ? "Collapse all context" : "Expand full file"}>
      {fullFile ? <Minimize2 aria-hidden="true" size={13} /> : <Maximize2 aria-hidden="true" size={13} />}
      <span>{fullFile ? "Collapse all" : "Expand all"}</span>
    </button>}
    {githubFileUrl && <a className="github-file-action" aria-label="Open file in GitHub" href={githubFileUrl} target="_blank" rel="noreferrer" title="Open file in GitHub">
      <GitHubIcon />
    </a>}
  </div>;

  if (snippetRange) {
    const allLines = segments.flatMap((segment) => segment.kind === "lines" ? segment.lines : segment.gap.lines);
    const side = snippetRange.side === "LEFT" ? "old" : "next";
    const start = allLines.findIndex((line) => line[side] === snippetRange.startLine);
    const end = allLines.findIndex((line) => line[side] === snippetRange.endLine);
    const snippet = start < 0 ? [] : allLines.slice(Math.max(0, start - 2), Math.min(allLines.length, Math.max(start, end) + 3));
    return <div className="diff-shell"><div className={classNames("diff", "diff-compact", (pureAddition || pureDeletion || unchanged) && "diff-pure")}>
      <div className="diff-lines">{snippet.map(renderLine)}</div></div></div>;
  }
  return <div className="diff-shell">
    <div className={classNames("diff", compact && "diff-compact", (pureAddition || pureDeletion || unchanged) && "diff-pure")} ref={containerRef}>
      {gaps.length === 0 && githubFileUrl && <div className="diff-gap diff-control-gap">{globalActions}</div>}
      {segments.map((segment) => segment.kind === "lines"
        ? <div className="diff-lines" key={segment.id}>{segment.lines.map(renderLine)}</div>
        : <div className="diff-segment" key={segment.gap.id}>
          <div className="diff-gap">
            <button
              className="diff-gap-toggle"
              onClick={() => {
                const expanded = fullFile || expandedGaps.has(segment.gap.id);
                if (fullFile) setFullFile(false);
                setExpandedGaps((current) => {
                  const next = new Set(current);
                  if (expanded) next.delete(segment.gap.id);
                  else next.add(segment.gap.id);
                  return next;
                });
              }}
              title={fullFile || expandedGaps.has(segment.gap.id) ? "Collapse hidden lines" : "Expand hidden lines"}
            >
              {fullFile || expandedGaps.has(segment.gap.id)
                ? <FoldVertical aria-hidden="true" size={13} />
                : <UnfoldVertical aria-hidden="true" size={13} />}
              <span>{fullFile || expandedGaps.has(segment.gap.id) ? "Collapse" : "Expand"} {segment.gap.lines.length} hidden {segment.gap.lines.length === 1 ? "line" : "lines"}</span>
            </button>
            {segment.gap.id === gaps[0]?.gap.id && globalActions}
          </div>
          {(fullFile || expandedGaps.has(segment.gap.id)) && <div className="diff-lines">{segment.gap.lines.map(renderLine)}</div>}
        </div>)}
    </div>
  </div>;
}

function StatusBadge({ status }: Pick<Check, "status">): ReactNode {
  return <span className={`status status-${status}`}>{statusLabel(status)}</span>;
}

function ChangeIcon({ change }: { change: TestCaseChangeKind }): ReactNode {
  return <span className="test-change-icon" role="img" aria-label={change}>
    {change === "added" && <Plus aria-hidden="true" size={13} />}
    {change === "removed" && <Minus aria-hidden="true" size={13} />}
    {change === "changed" && <RefreshCw aria-hidden="true" size={12} />}
    {change === "moved" && <ArrowRight aria-hidden="true" size={13} />}
  </span>;
}

function CheckGroup({ title, checks, empty }: { title: string; checks: Check[]; empty: string }): ReactNode {
  return <section className="check-group">
    <div className="eyebrow">{title}</div>
    {checks.length === 0 ? <p className="muted compact-copy">{empty}</p> : checks.map((check, index) =>
      <div className="check" key={`${check.label}-${index}`}>
        <div className="check-heading"><span>{check.label}</span><StatusBadge status={check.status} /></div>
        {check.command && <code className="command">{check.command}</code>}
        {check.detail && <p>{check.detail}</p>}
      </div>)}
  </section>;
}

function FixtureStatus({ run }: { run: TestFixtureRun }): ReactNode {
  const failing = run.status === "failing" || run.status === "timed-out";
  return <span className={`status status-${failing ? "failing" : run.status}`}>
    {failing ? "Failing" : run.status === "passing" ? "Passing" : "Not run"}
    {run.output && <ChevronDown aria-hidden="true" size={12} />}
  </span>;
}

function TestFixtureResult({
  run,
  active,
  onSelectFile,
  stepId,
}: {
  run: TestFixtureRun;
  stepId?: string;
  active: boolean;
  onSelectFile: (file: string) => void;
}): ReactNode {
  const review = useReviewActions();
  const [expanded, setExpanded] = useState(false);
  const separator = run.file.lastIndexOf("/");
  const directory = separator === -1 ? "" : run.file.slice(0, separator + 1);
  const filename = separator === -1 ? run.file : run.file.slice(separator + 1);
  return <CommentAnchor target={{ kind: "file", stepId: stepId ?? review?.step.id ?? "", anchor: `fixture:${run.file}`, path: run.file }}><div className={classNames("test-fixture-run", expanded && "expanded")}>
    <button
      aria-label={`Open ${run.file} in diff`}
      className={classNames("test-fixture-file", active && "active")}
      onClick={() => onSelectFile(run.file)}
      title={`Open ${run.file} in diff`}
    >
      <span className="test-fixture-path"><span>{directory}</span><strong>{filename}</strong></span>
    </button>
    {run.output ? <button
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} test output for ${run.file}`}
      className="test-fixture-status-toggle"
      onClick={() => setExpanded((current) => !current)}
      title={`${expanded ? "Hide" : "Show"} test output`}
    >
      <FixtureStatus run={run} />
    </button> : <span className="test-fixture-status-static"><FixtureStatus run={run} /></span>}
    {run.output && <pre className="test-run-output" hidden={!expanded}>{run.output}</pre>}
  </div></CommentAnchor>;
}

export function newestFixtureRuns(steps: RenderStep[], stepIndex: number): TestFixtureRun[] {
  const introduced = new Map<string, number>();
  steps.slice(0, stepIndex + 1).forEach((step, index) => {
    for (const run of step.testRun?.fixtureRuns ?? []) {
      if (!introduced.has(run.file)) introduced.set(run.file, index);
    }
  });
  return [...(steps[stepIndex].testRun?.fixtureRuns ?? [])]
    .sort((left, right) => introduced.get(right.file)! - introduced.get(left.file)!);
}

function Checks({
  step,
  fixtureRuns,
  selectedFile,
  onSelectFile,
}: {
  step: RenderStep;
  fixtureRuns: TestFixtureRun[];
  selectedFile: string | null;
  onSelectFile: (file: string) => void;
}): ReactNode {
  return <div className="checks">
    <section className="check-group test-results">
      <div className="test-summary-heading">
        <div className="eyebrow">Tests</div>
        <span className="test-summary-count">{`${fixtureRuns.filter((run) => run.status === "passing").length}/${fixtureRuns.length} passing`}</span>
      </div>
      {fixtureRuns.length === 0
        ? <p className="muted compact-copy">No test fixtures run at this point.</p>
        : <div className="test-fixture-runs">{fixtureRuns.map((run) => <TestFixtureResult
          active={selectedFile === run.file}
          key={run.file}
          onSelectFile={onSelectFile}
          run={run}
        />)}</div>}
    </section>
    <CheckGroup title="Manual checks" checks={step.checks.manual} empty="No manual checks apply at this point." />
    {step.testRun?.scope === "full-suite" && step.testRun.unexpectedFailures.length > 0 && <details className="unexpected-test-details">
      <summary><span>{step.testRun.unexpectedFailures.length} full-suite {step.testRun.unexpectedFailures.length === 1 ? "failure" : "failures"}</span></summary>
      <div className="unexpected-test-content">
        <ul>{step.testRun.unexpectedFailures.map((failure, index) => <li key={`${failure}-${index}`}>{failure}</li>)}</ul>
        {step.testRun.output && <details className="test-output">
          <summary><ChevronRight aria-hidden="true" size={13} />Test output</summary>
          <pre>{step.testRun.output}</pre>
        </details>}
      </div>
    </details>}
  </div>;
}

function FileLink({
  file,
  label,
  active,
  onSelect,
  connected = false,
  connectedCollapsed = false,
  annotatable = true,
  inline = false,
  change,
  from,
}: {
  file: string;
  from?: string;
  label?: string;
  active: boolean;
  onSelect: (file: string) => void;
  connected?: boolean;
  connectedCollapsed?: boolean;
  annotatable?: boolean;
  inline?: boolean;
  change?: TestCaseChangeKind;
}): ReactNode {
  const review = useReviewActions();
  const patch = review?.step.fileDiffs.find((candidate) => candidate.path === file)?.patch;
  const movedFrom = from ?? (patch ? patchRename(patch)?.from : undefined);
  if (movedFrom) change = "moved";
  const title = movedFrom ? `${movedFrom} -> ${file}` : file;
  const target = { kind: "file" as const, stepId: review?.step.id ?? "", anchor: `file:${file}:${label ?? ""}`, path: file };
  const separator = file.lastIndexOf("/");
  const directory = separator === -1 ? "" : file.slice(0, separator + 1);
  const filename = separator === -1 ? file : file.slice(separator + 1);
  const wrap = (content: ReactNode) => annotatable ? <CommentAnchor target={target} inline={inline} centered>{content}</CommentAnchor> : content;
  if (inline) return wrap(<button className="file-link file-link-inline" onClick={() => onSelect(file)} title={title}>
    <strong className="file-link-filename">{filename}</strong>
  </button>);
  return wrap(<button className={classNames("file-link", connected && "file-link-connected", connectedCollapsed && "connected-collapsed", active && "active", change && `test-case-${change}`)} onClick={() => onSelect(file)} title={title}>
    {change && <ChangeIcon change={change} />}
    <span className="file-link-copy">
      {label && <span className="file-link-label">{label}</span>}
      <span className="file-link-path">
        {movedFrom && <><span className="file-link-directory">{movedFrom}</span><span className="file-link-move-arrow">{" -> "}</span></>}
        {directory && <span className="file-link-directory">{directory}</span>}
        <strong className="file-link-filename">{filename}</strong>
      </span>
    </span>
  </button>);
}

function StepHeading({ step }: { step: RenderStep }): ReactNode {
  return <header className="step-heading">
    <div className="eyebrow">Step {step.number} · {kindLabel(step.kind)}</div>
    <h1>{step.title}</h1>
    <div className="diff-stats">{step.patch && <><span>+{step.stats.additions}</span><span>−{step.stats.deletions}</span><span>{step.stats.files} {step.stats.files === 1 ? "file" : "files"}</span></>}</div>
  </header>;
}

function allStepFiles(step: RenderStep): PatchFile[] {
  return [...step.fileDiffs, ...(step.referenceFiles ?? [])];
}

export function resolveStepFile(steps: RenderStep[], stepIndex: number, path: string | null): PatchFile | undefined {
  if (path === null) return undefined;
  for (let index = stepIndex; index >= 0; index -= 1) {
    const file = allStepFiles(steps[index]).find((candidate) => candidate.path === path);
    if (!file) continue;
    if (index === stepIndex) return file;
    if (file.afterContent === null || file.afterContent === undefined) return undefined;
    return { ...file, patch: "", beforeContent: file.afterContent };
  }
  return undefined;
}

function DescriptionStep({ step, onSelectFile }: StepViewProps): ReactNode {
  return <>
    <Markdown source={step.body} files={allStepFiles(step)} onSelectFile={onSelectFile} />
    {step.evidence && step.evidence.length > 0 && <section className="context-evidence">
      <div className="eyebrow">References</div>
      <EvidenceGallery evidence={step.evidence} />
    </section>}
  </>;
}

function TestsStep({ step, selectedFile, onSelectFile }: StepViewProps): ReactNode {
  const areas = (step.testAreas ?? []).map((area) => ({
    ...area,
    files: area.files.map((file) => {
      const patch = step.fileDiffs.find((candidate) => candidate.path === file.path)?.patch ?? "";
      // Older stored reviews classified every case in a renamed fixture as added.
      if (!patchRename(patch) || /^@@/m.test(patch)) return file;
      return { ...file, cases: file.cases.map((testCase) => ({ ...testCase, change: "moved" as const })) };
    }),
  }));
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  return <>
    {step.body && <Markdown source={step.body} files={allStepFiles(step)} onSelectFile={onSelectFile} />}
    <div className="test-areas">
      {areas.map((area, index) => <section className="test-area" key={`${area.name}-${index}`}>
        <div className="test-area-description">
          <div className="test-area-heading"><h3>{area.name}</h3><span className="test-type-badge">Automated test</span></div>
          <Markdown source={area.description} annotationKey={`area:${index}`} section={area.name} />
        </div>
        {area.files.map((file) => <div className="test-file" key={file.path}>
          <div className="connected-file-header">
            <FileLink file={file.path} active={selectedFile === file.path} onSelect={onSelectFile} connected connectedCollapsed={collapsedFiles.has(file.path)} />
            <button
              aria-expanded={!collapsedFiles.has(file.path)}
              aria-label={collapsedFiles.has(file.path) ? `Expand ${file.path} test cases` : `Collapse ${file.path} test cases`}
              className={classNames("inline-diff-toggle", collapsedFiles.has(file.path) && "collapsed")}
              onClick={() => setCollapsedFiles((current) => {
                const next = new Set(current);
                if (next.has(file.path)) next.delete(file.path);
                else next.add(file.path);
                return next;
              })}
              title={collapsedFiles.has(file.path) ? "Expand test cases" : "Collapse test cases"}
            >{collapsedFiles.has(file.path)
              ? <ChevronDown aria-hidden="true" size={15} />
              : <ChevronUp aria-hidden="true" size={15} />}
            </button>
          </div>
          {!collapsedFiles.has(file.path) && (file.cases.length > 0 ? <ul className="test-case-list connected-case-list">
            {file.cases.map((testCase, caseIndex) => <li className={`test-case-${testCase.change}`} key={`${testCase.name}-${caseIndex}`}>
              <CommentAnchor target={testCase.newLine === undefined && testCase.oldLine === undefined
                ? { kind: "file", stepId: step.id, anchor: `test:${file.path}:${caseIndex}`, path: file.path }
                : { kind: "line", stepId: step.id, anchor: `test:${file.path}:${caseIndex}`, path: file.path,
                side: testCase.newLine !== undefined ? "RIGHT" : "LEFT", startLine: testCase.newLine ?? testCase.oldLine ?? 1,
                endLine: testCase.newLine !== undefined ? testCase.newEndLine ?? testCase.newLine : testCase.oldEndLine ?? testCase.oldLine ?? 1 }}>
              <button className="test-case-link"
                aria-label={`${testCase.change} test: ${testCase.name}`}
                onClick={() => onSelectFile(file.path, {
                  oldLine: testCase.oldLine,
                  oldEndLine: testCase.oldEndLine,
                  newLine: testCase.newLine,
                  newEndLine: testCase.newEndLine,
                })}
                title={`Open ${testCase.change} test in diff`}
              >
                <ChangeIcon change={testCase.change} />
                <code>{testCase.name}</code>
              </button>
              </CommentAnchor>
            </li>)}
          </ul> : <p className="muted no-test-cases connected-empty-tests">No named test cases changed in this file.</p>)}
        </div>)}
      </section>)}
    </div>
    {step.checks.manual.length > 0 && <div className="manual-test-areas">
      {step.checks.manual.map((check, index) => <section className="manual-test-area" key={`${check.label}-${index}`}>
        <div className="test-area-heading">
          <h3>{check.label}</h3>
          <span className="test-type-badge">Manual test</span>
        </div>
        {check.detail && <p>{check.detail}</p>}
        <StatusBadge status={check.status} />
        {check.evidence && <EvidenceGallery evidence={check.evidence} />}
      </section>)}
    </div>}
    {step.evidence && step.evidence.length > 0 && <section className="manual-evidence">
      <div className="test-area-heading">
        <h3>Evidence from the pull request</h3>
        <span className="test-type-badge">Manual test</span>
      </div>
      <EvidenceGallery evidence={step.evidence} />
    </section>}
  </>;
}

function ChangedFileList({ files, step, selectedFile, onSelectFile }: StepViewProps & { files: Callsite[] }): ReactNode {
  const callsiteChange = (file: string, declared?: TestCaseChangeKind) => {
    const snapshot = step.fileDiffs.find((candidate) => candidate.path === file);
    if (snapshot && patchRename(snapshot.patch)) return "moved";
    if (declared) return declared;
    if (snapshot?.beforeContent === null) return "added";
    if (snapshot?.afterContent === null) return "removed";
    return "changed";
  };
  return <div className="connected-file-list">
    {files.map((file, index) => <FileLink
      file={file.file}
      label={file.label}
      change={callsiteChange(file.file, file.change)}
      key={`${file.file}-${index}`}
      active={selectedFile === file.file}
      onSelect={onSelectFile}
    />)}
  </div>;
}

function RefactorStep({ step, selectedFile, onSelectFile }: StepViewProps): ReactNode {
  const interfaces = step.interfaces ?? [];
  return <>
    {step.body && <Markdown source={step.body} files={allStepFiles(step)} onSelectFile={onSelectFile} />}
    <div className="refactor-sections">
      {interfaces.map((item, index) => <section className="refactor-section" key={index}>
        <div className="interface-change">
          <h3>{item.name}</h3>
          {item.description && <Markdown source={item.description} annotationKey={`interface:${index}`} section={item.name} />}
          {(item.before || item.after) && <div className="before-after">
            {item.before && <div><span>Before</span><Markdown source={item.before} files={allStepFiles(step)} onSelectFile={onSelectFile} annotatable={false} /></div>}
            {item.after && <div><span>After</span><Markdown source={item.after} files={allStepFiles(step)} onSelectFile={onSelectFile} annotatable={false} /></div>}
          </div>}
          {item.file && <div className="refactor-file-group">
            <div className="refactor-subheading">Source</div>
            <div className="connected-file-list">
              <FileLink file={item.file} active={selectedFile === item.file} onSelect={onSelectFile} />
            </div>
          </div>}
          <div className="refactor-file-group">
            <div className="refactor-subheading">Call sites</div>
            <ChangedFileList files={item.callsites} step={step} selectedFile={selectedFile} onSelectFile={onSelectFile} />
          </div>
        </div>
      </section>)}
    </div>
  </>;
}

function githubFileUrl(source: RenderModel["source"], file: PatchFile): string | null {
  if (!source.github) return null;
  const revision = file.afterContent === null ? source.base : source.head;
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  return `${source.github.repositoryUrl}/blob/${revision}/${path}`;
}

function ImplementationStep({
  step,
  selectedFile,
  onSelectFile,
  source,
}: StepViewProps & { source: RenderModel["source"] }): ReactNode {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const filesByPath = new Map(step.fileDiffs.map((file) => [file.path, file]));
  return <>
    {step.body && <Markdown source={step.body} files={allStepFiles(step)} onSelectFile={onSelectFile} />}
    <div className="implementation-sections">
      {(step.sections ?? []).map((section, index) => <section className="implementation-section" key={index}>
        <div className="test-area-heading">
          <h3>{section.name}</h3>
          <span className={classNames("test-type-badge", section.priority === "critical" && "critical-badge")}>{section.priority === "critical" ? "Critical" : "Secondary"}</span>
        </div>
        <Markdown source={section.description} files={allStepFiles(step)} onSelectFile={onSelectFile} />
        {section.priority === "secondary"
          ? <ChangedFileList files={section.files} step={step} selectedFile={selectedFile} onSelectFile={onSelectFile} />
          : section.files.map((entry) => {
            const file = filesByPath.get(entry.file);
            if (!file) return null;
            return <div className="focused-diff" key={file.path}>
              <div className="connected-file-header">
                <FileLink file={file.path} label={entry.label} active={selectedFile === file.path} onSelect={onSelectFile} connected connectedCollapsed={collapsedFiles.has(file.path)} />
                <button
                  aria-expanded={!collapsedFiles.has(file.path)}
                  aria-label={collapsedFiles.has(file.path) ? `Expand ${file.path} diff` : `Collapse ${file.path} diff`}
                  className={classNames("inline-diff-toggle", collapsedFiles.has(file.path) && "collapsed")}
                  onClick={() => setCollapsedFiles((current) => {
                    const next = new Set(current);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })}
                  title={collapsedFiles.has(file.path) ? "Expand inline diff" : "Collapse inline diff"}
                >{collapsedFiles.has(file.path)
                  ? <ChevronDown aria-hidden="true" size={15} />
                  : <ChevronUp aria-hidden="true" size={15} />}
                </button>
              </div>
              {!collapsedFiles.has(file.path) && <DiffView
                filePath={file.path}
                patch={file.patch}
                beforeContent={file.beforeContent}
                afterContent={file.afterContent}
                githubFileUrl={githubFileUrl(source, file)}
              />}
            </div>;
          })}
      </section>)}
    </div>
  </>;
}

interface StepViewProps {
  step: RenderStep;
  selectedFile: string | null;
  onSelectFile: (file: string, target?: DiffTarget) => void;
}

function StepContent({
  step,
  selectedFile,
  onSelectFile,
  source,
}: StepViewProps & { source: RenderModel["source"] }): ReactNode {
  if (step.kind === "tests" || step.kind === "manual") return <TestsStep step={step} selectedFile={selectedFile} onSelectFile={onSelectFile} />;
  if (step.kind === "refactor") return <RefactorStep step={step} selectedFile={selectedFile} onSelectFile={onSelectFile} />;
  if (step.kind === "implementation") return <ImplementationStep step={step} selectedFile={selectedFile} onSelectFile={onSelectFile} source={source} />;
  return <DescriptionStep step={step} selectedFile={selectedFile} onSelectFile={onSelectFile} />;
}

export function reviewRailItems(model: RenderModel, comments: ReviewComment[]) {
  const commented = new Map<string, { path: string; stepId: string }>();
  for (const { body, target } of comments) {
    if (body.trim() && (target.kind === "file" || target.kind === "line")) commented.set(target.path, { path: target.path, stepId: target.stepId });
  }
  const tests = new Map<string, { path: string; stepId: string; testCase: ParsedTestCaseChange; caseIndex: number }>();
  for (const step of model.steps) for (const area of step.testAreas ?? []) for (const file of area.files) {
    file.cases.forEach((testCase, caseIndex) => tests.set(JSON.stringify([file.path, testCase.name]), { path: file.path, stepId: step.id, testCase, caseIndex }));
  }
  return {
    commentedFiles: [...commented.values()],
    changedTests: [...tests.values()],
    changedFiles: (model.source.files ?? []).map((file) => ({ ...file, stepId: model.steps.slice().reverse().find((step) => step.fileDiffs.some((changed) => changed.path === file.path))?.id ?? model.steps.at(-1)!.id })),
  };
}

function ReviewSummaryRail({ onSelectFile }: { onSelectFile: (path: string, stepId: string, target?: DiffTarget) => void }) {
  const context = useReviewComments()!;
  const { commentedFiles, changedTests, changedFiles } = reviewRailItems(context.model, context.state?.draft.comments ?? []);
  const changedTestFiles = [...new Map(changedTests.map((test) => [test.path, test])).values()];
  const latestRuns = context.model.steps.slice().reverse().flatMap((step) => step.testRun?.fixtureRuns ?? []);
  return <div className="review-summary-lists">
    <section><h3 className="eyebrow">{commentedFiles.length} {commentedFiles.length === 1 ? "file" : "files"} commented on</h3>
      <ul className="file-pills">{commentedFiles.map((file) => <li key={file.path}><FileLink file={file.path} active={false} onSelect={(path) => onSelectFile(path, file.stepId)} /></li>)}</ul>
    </section>
    <section><h3 className="eyebrow">{changedTests.length} test {changedTests.length === 1 ? "case" : "cases"} changed</h3>
      <ul className="test-fixture-runs review-test-runs">{changedTestFiles.map(({ path, stepId }) => {
        const run: TestFixtureRun = latestRuns.find((run) => run.file === path) ?? {
          file: path, command: "", status: "not-run", expectedStatus: "not-specified", expectationMatched: null,
          exitCode: null, durationMs: 0, observedFailures: [], unexpectedFailures: [], output: "",
        };
        return <li key={path}><TestFixtureResult run={run} stepId={stepId} active={false} onSelectFile={(file) => onSelectFile(file, stepId)} /></li>;
      })}</ul>
    </section>
    <section><h3 className="eyebrow">{changedFiles.length} {changedFiles.length === 1 ? "file" : "files"} changed</h3>
      <ul className="file-pills">{changedFiles.map((file) => <li key={file.path}><FileLink file={file.path} from={file.status.startsWith("R") ? file.from : undefined} active={false} onSelect={(path) => onSelectFile(path, file.stepId)} /></li>)}</ul>
    </section>
  </div>;
}

function DetailPanel({
  step,
  source,
  selected,
  selectedFile,
  onSelectFile,
  tabs,
  onReorderTab,
  fixtureRuns,
  onCloseFile,
  scrollTarget,
  detailWidth,
  collapsed,
  onToggle,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onResizeKeyDown,
  reviewSummary = false,
  onSelectReviewFile,
  mobile = false,
  panelRef,
}: StepViewProps & {
  source: RenderModel["source"];
  tabs: string[];
  onReorderTab: (from: string, to: string) => void;
  fixtureRuns: TestFixtureRun[];
  selected: PatchFile | undefined;
  reviewSummary?: boolean;
  onSelectReviewFile?: (path: string, stepId: string, target?: DiffTarget) => void;
  onCloseFile: (file: string) => void;
  scrollTarget: DiffTarget | null;
  detailWidth: number;
  collapsed: boolean;
  onToggle: () => void;
  onResizePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onResizePointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onResizePointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  mobile?: boolean;
  panelRef?: RefObject<HTMLElement | null>;
}): ReactNode {
  const [draggingTab, setDraggingTab] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const resetDrag = () => { setDraggingTab(null); setDropTarget(null); };
  const dragHandlers = (tab: string) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", tab || "Step summary");
      setDraggingTab(tab);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (draggingTab === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(tab);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (draggingTab === null) return;
      event.preventDefault();
      event.stopPropagation();
      onReorderTab(draggingTab, tab);
      resetDrag();
    },
    onDragEnd: resetDrag,
  });
  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, tab: string) => {
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const neighbor = tabs[tabs.indexOf(tab) + (event.key === "ArrowLeft" ? -1 : 1)];
    if (neighbor !== undefined) onReorderTab(tab, neighbor);
  };
  const toggle = <button
    key="details-toggle"
    aria-expanded={!collapsed}
    aria-label={collapsed ? "Expand details panel" : "Collapse details panel"}
    className={classNames("panel-toggle", collapsed ? "detail-toggle-floating" : "detail-toggle")}
    onClick={onToggle}
    title={collapsed ? "Expand details panel" : "Collapse details panel"}
  >{collapsed
    ? <PanelRightOpen aria-hidden="true" size={16} />
    : <PanelRightClose aria-hidden="true" size={16} />}
  </button>;
  if (collapsed) return mobile ? null : toggle;
  const selectedGitHubUrl = selected ? githubFileUrl(source, selected) : null;
  return <aside id="review-detail-panel" ref={panelRef} className="detail-panel" role={mobile ? "dialog" : undefined} aria-modal={mobile || undefined} aria-label="Review details">
    {mobile && <div className="mobile-panel-header"><strong>Review details</strong><button aria-label="Close review details" onClick={onToggle}><X size={22} aria-hidden="true" /></button></div>}
    <div
      aria-label="Resize details panel"
      aria-orientation="vertical"
      aria-valuemax={720}
      aria-valuemin={320}
      aria-valuenow={detailWidth}
      className="resize-handle"
      onKeyDown={onResizeKeyDown}
      onPointerDown={onResizePointerDown}
      onPointerMove={onResizePointerMove}
      onPointerUp={onResizePointerUp}
      onPointerCancel={onResizePointerUp}
      role="separator"
      tabIndex={0}
    />
    <div className="detail-header">
      <div className="detail-tabs" role="tablist" aria-label="Review details"
        onDragOver={(event) => {
          if (draggingTab === null) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left + 32) event.currentTarget.scrollLeft -= 16;
          if (event.clientX > bounds.right - 32) event.currentTarget.scrollLeft += 16;
        }}
        onDrop={(event) => {
          if (draggingTab === null) return;
          event.preventDefault();
          onReorderTab(draggingTab, tabs.at(-1)!);
          resetDrag();
        }}
      >
        {tabs.map((file) => file === "" ? <button
          {...dragHandlers(file)}
          key={file}
          aria-selected={selectedFile === null}
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
          aria-description="Drag to reorder, or press Alt and an arrow key."
          className={classNames("detail-tab", "summary-tab", selectedFile === null && "active", draggingTab === file && "tab-dragging", dropTarget === file && "tab-drop-target")}
          onClick={() => onSelectFile("")}
          onKeyDown={(event) => moveWithKeyboard(event, file)}
          role="tab"
        >{reviewSummary ? "Review summary" : "Step summary"}</button> : <div
          {...dragHandlers(file)}
          className={classNames("file-tab", selectedFile === file && "active", draggingTab === file && "tab-dragging", dropTarget === file && "tab-drop-target")}
          key={file}
        >
          <button
            key="select"
            aria-selected={selectedFile === file}
            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
            aria-description="Drag to reorder, or press Alt and an arrow key."
            onClick={() => onSelectFile(file)}
            onKeyDown={(event) => moveWithKeyboard(event, file)}
            role="tab"
            title={file}
          >{file.split("/").at(-1)}</button>
          <button key="close" aria-label={`Close ${file}`} className="close-tab" onClick={() => onCloseFile(file)} title={`Close ${file}`}><X aria-hidden="true" size={13} /></button>
        </div>)}
      </div>
      {!mobile && toggle}
    </div>
    {selectedFile === null && <div className="detail-panel-content">
      {reviewSummary ? <ReviewSummaryRail onSelectFile={onSelectReviewFile!} />
        : <Checks step={step} fixtureRuns={fixtureRuns} selectedFile={selectedFile} onSelectFile={onSelectFile} />}
      {!reviewSummary && step.fileDiffs.length > 0 && <section className="changed-files">
        <div className="eyebrow">Files in this step</div>
        <div className="file-pills">{step.fileDiffs.map((file) => <FileLink file={file.path} active={false} onSelect={onSelectFile} key={file.path} />)}</div>
      </section>}
    </div>}
    {selected && <div className="detail-panel-content file-tab-content">
      <div className="tab-diff">
        <DiffView
          filePath={selected.path}
          commentStepId={step.id}
          patch={selected.patch}
          compact
          scrollTarget={scrollTarget}
          beforeContent={selected.beforeContent}
          afterContent={selected.afterContent}
          githubFileUrl={selectedGitHubUrl}
        />
      </div>
    </div>}
    {!collapsed && selectedFile !== null && !selected && <div className="detail-panel-content">
      <p className="muted">File content is unavailable at this step.</p>
    </div>}
  </aside>;
}

function ReviewThread({ comment, model, onSelectFile }: { comment: ReviewComment; model: RenderModel; onSelectFile: (path: string, stepIndex: number, target?: DiffTarget) => void }) {
  const target = comment.target;
  if (target.kind !== "file" && target.kind !== "line") return null;
  const stepIndex = model.steps.findIndex((step) => step.id === target.stepId);
  const file = resolveStepFile(model.steps, stepIndex, target.path);
  const location = target.kind === "line" ? target.side === "LEFT" ? { oldLine: target.startLine, oldEndLine: target.endLine } : { newLine: target.startLine, newEndLine: target.endLine } : undefined;
  return <><header><FileLink file={target.path} active={false} annotatable={false}
    onSelect={(path) => onSelectFile(path, stepIndex, location)} /></header>
    {target.kind === "line" && file && <DiffView filePath={target.path} patch={file.patch} beforeContent={file.beforeContent} afterContent={file.afterContent} snippetRange={target} />}
    <CodeCommentBlock commentId={comment.id} autofocus={false} />
  </>;
}

const mobileReviewQuery = "(max-width: 900px)";
function subscribeMobileReview(onChange: () => void) {
  const query = window.matchMedia(mobileReviewQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function isMobileReview() { return window.matchMedia(mobileReviewQuery).matches; }
function desktopReviewSnapshot() { return false; }

function StepIndex({ stepId, number }: { stepId: string; number: number }) {
  const hasComments = useReviewSelection((snapshot) => Boolean(snapshot.state?.draft.comments.some((comment) => comment.target.stepId === stepId && comment.body.trim())), Object.is);
  return <span className="step-index">
    <span className="step-number">{String(number).padStart(2, "0")}</span>
    {hasComments && <span className="step-comment-indicator" role="img" aria-label="This step has comments" title="This step has comments">
      <MessageSquare size={14} aria-hidden="true" />
    </span>}
  </span>;
}

export function ReviewViewer({
  data,
  reviewId,
  updatedAt,
  updating = false,
  status = updating ? "pending" : "ready",
  progress = null,
}: {
  data: RenderModel;
  reviewId?: string;
  updatedAt: string;
  updating?: boolean;
  status?: ReviewStatus;
  progress?: string | null;
}): ReactNode {
  const router = useRouter();
  const mobile = useSyncExternalStore(subscribeMobileReview, isMobileReview, desktopReviewSnapshot);
  const [mobilePanel, setMobilePanel] = useState<"steps" | "details" | null>(null);
  const stepNavRef = useRef<HTMLElement>(null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const [liveStatus, setLiveStatus] = useState<{ updatedAt: string; status: ReviewStatus; progress: string | null } | null>(null);
  const currentStatus = liveStatus?.updatedAt === updatedAt ? liveStatus : { status, progress };
  const isUpdating = currentStatus.status === "pending" || currentStatus.status === "preparing";

  useEffect(() => {
    if (!reviewId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/service/reviews?review=${encodeURIComponent(reviewId)}`, { cache: "no-store" });
        if (!response.ok) return;
        const review = await response.json() as { status: ReviewStatus; updatedAt: string; progress: string | null };
        if (stopped) return;
        const pending = review.status === "pending" || review.status === "preparing";
        setLiveStatus((current) => current?.updatedAt === updatedAt && current.status === review.status && current.progress === review.progress ? current : { updatedAt, status: review.status, progress: review.progress });
        if (!pending && (review.updatedAt !== updatedAt || updating)) router.refresh();
      } catch {
        // Keep the current review available through a transient polling failure.
      } finally {
        if (!stopped) timer = setTimeout(poll, 1_000);
      }
    };
    timer = setTimeout(poll, 1_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [reviewId, router, updatedAt, updating]);

  const [stepId, setStepId] = useState<string | null>(data.steps[0].id);
  const selectStep = (id: string | null) => { setStepId(id); setMobilePanel(null); };
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [detailWidth, setDetailWidth] = useState(420);
  const [tabs, setTabs] = useState<string[]>([""]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<DiffTarget | null>(null);
  const [reviewFileSteps, setReviewFileSteps] = useState<Record<string, number>>({});
  const [detailPreferencesLoaded, setDetailPreferencesLoaded] = useState(false);
  const githubMetadata = useCachedGitHubPullRequestMetadata(reviewId ?? String(data.source.github?.number ?? ""));
  const githubMetadataLoading = Boolean(data.source.github && githubMetadata === undefined);
  const githubReview = Boolean(!mobile && data.source.github && (githubMetadata?.state === "open" || githubMetadata?.state === "draft"));
  const finalReview = githubReview && stepId === null;
  const stepIndex = finalReview ? data.steps.length : Math.max(0, data.steps.findIndex((item) => item.id === stepId));
  const totalSteps = data.steps.length + Number(githubReview);
  const step = data.steps[Math.min(stepIndex, data.steps.length - 1)];
  const detailStepIndex = finalReview && selectedFile ? reviewFileSteps[selectedFile] ?? data.steps.length - 1 : Math.min(stepIndex, data.steps.length - 1);
  const selected = useMemo(() => resolveStepFile(data.steps, detailStepIndex, selectedFile), [data.steps, detailStepIndex, selectedFile]);
  const stepContentRef = useRef<HTMLDivElement>(null);
  const initializedFromLocation = useRef(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    if (!mobile || !mobilePanel) return;
    const panel = mobilePanel === "steps" ? stepNavRef.current : detailPanelRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], textarea:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMobilePanel(null); }
      if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [mobile, mobilePanel]);

  const resizeDetailPanel = (width: number) => {
    setDetailWidth(Math.min(720, Math.max(320, width)));
  };

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    resizeStart.current = { x: event.clientX, width: detailWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return;
    resizeDetailPanel(resizeStart.current.width + resizeStart.current.x - event.clientX);
  };

  const handleResizePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    resizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    resizeDetailPanel(detailWidth + (event.key === "ArrowLeft" ? 24 : -24));
  };

  const openFile = (file: string, target?: DiffTarget) => {
    if (mobile) setMobilePanel("details");
    if (!file) {
      setSelectedFile(null);
      setScrollTarget(null);
      return;
    }
    setTabs((files) => files.includes(file) ? files : [...files, file]);
    setSelectedFile(file);
    setScrollTarget(target ? { ...target } : null);
    if (!mobile) setRightCollapsed(false);
  };

  const reorderTab = (from: string, to: string) => {
    setTabs((current) => {
      const fromIndex = current.indexOf(from);
      const toIndex = current.indexOf(to);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
      const reordered = [...current];
      reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, from);
      return reordered;
    });
  };

  const closeFile = (file: string) => {
    setTabs((files) => files.filter((candidate) => candidate !== file));
    if (selectedFile === file) {
      setSelectedFile(null);
      setScrollTarget(null);
    }
  };

  useEffect(() => {
    const storedWidth = Number(localStorage.getItem("heptapod.detail-width"));
    if (Number.isFinite(storedWidth) && storedWidth > 0) resizeDetailPanel(storedWidth);
    const storedCollapsed = localStorage.getItem("heptapod.detail-collapsed");
    if (storedCollapsed === "true" || storedCollapsed === "false") setRightCollapsed(storedCollapsed === "true");
    setDetailPreferencesLoaded(true);
  }, []);

  useEffect(() => {
    if (!detailPreferencesLoaded) return;
    localStorage.setItem("heptapod.detail-width", String(detailWidth));
    localStorage.setItem("heptapod.detail-collapsed", String(rightCollapsed));
  }, [detailPreferencesLoaded, detailWidth, rightCollapsed]);

  useEffect(() => {
    if (!initializedFromLocation.current) {
      if (githubMetadataLoading && window.location.hash === "#review-draft") return;
      initializedFromLocation.current = true;
      if (githubReview && window.location.hash === "#review-draft") { setStepId(null); return; }
      const requestedIndex = data.steps.findIndex((item) => `#${item.id}` === window.location.hash);
      if (requestedIndex > 0) {
        setStepId(data.steps[requestedIndex].id);
        return;
      }
    }
    setTabs([""]);
    setSelectedFile(null);
    setScrollTarget(null);
    stepContentRef.current?.scrollTo({ top: 0 });
    history.replaceState(null, "", finalReview ? "#review-draft" : `#${step.id}`);
    document.title = `${finalReview ? "Review" : `${step.number}. ${step.title}`} — ${data.title}`;
  }, [data.steps, data.title, step, finalReview, githubReview, githubMetadataLoading]);

  return <ReviewCommentsProvider disabled={mobile} key={`${reviewId ?? data.source.base}:${data.source.head}`} model={data} reviewId={reviewId ?? String(data.source.github?.number ?? "")} step={step} updating={currentStatus.status !== "ready"} renderMarkdown={(source) => <Markdown source={source} annotatable={false} />}><ReviewRuntimeContext.Provider value={{ reviewId }}><div className={`app-shell${isUpdating ? " app-shell-updating" : ""}${mobile && mobilePanel ? ` mobile-${mobilePanel}-open` : ""}`}>
    <header className="topbar" inert={mobile && mobilePanel !== null}>
      <ReviewHeader review={{
        id: reviewId ?? `${data.source.base}/${data.source.head}`,
        title: data.title,
        summary: data.summary,
        sourceUrl: data.source.github?.pullRequestUrl ?? null,
        baseRevision: data.source.base,
        headRevision: data.source.head,
        updatedAt,
        additions: data.source.stats.additions,
        deletions: data.source.stats.deletions,
      }}>
        {isUpdating && <ReviewProgress status={currentStatus.status} updating progress={currentStatus.progress} />}
      </ReviewHeader>
    </header>
    <div className="mobile-review-controls" inert={mobilePanel !== null}>
      <button className="mobile-steps-toggle" aria-label="Open review steps" aria-controls="review-step-menu" aria-expanded={mobilePanel === "steps"} onClick={() => setMobilePanel("steps")}><Menu size={22} aria-hidden="true" /></button>
      <button className="mobile-details-toggle" aria-label="Open review details" aria-controls="review-detail-panel" aria-expanded={mobilePanel === "details"} onClick={() => setMobilePanel("details")}><PanelRightOpen size={22} aria-hidden="true" /></button>
    </div>
    <div
      className="workspace"
      style={{
        gridTemplateColumns: `276px minmax(480px, 1fr)${rightCollapsed ? "" : ` ${detailWidth}px`}`,
        "--detail-width": `${rightCollapsed ? 0 : detailWidth}px`,
      } as CSSProperties}
    >
      <nav id="review-step-menu" ref={stepNavRef} className="step-nav" aria-label="Narrative steps" role={mobile ? "dialog" : undefined} aria-modal={mobile && mobilePanel === "steps" || undefined}>
        <div className="mobile-panel-header"><strong>Review steps</strong><button aria-label="Close review steps" onClick={() => setMobilePanel(null)}><X size={22} aria-hidden="true" /></button></div>
        {data.steps.map((item, index) => {
          return <button className={classNames("step-button", index === stepIndex && "active")} onClick={() => selectStep(item.id)} key={item.id}>
            <StepIndex stepId={item.id} number={index + 1} />
            <span className="step-copy"><span>{item.title}</span><small>{kindLabel(item.kind)}</small></span>
            <span className={classNames(
              "step-dot",
              (item.testRun?.status === "failing" || item.testRun?.status === "timed-out") && "has-failure",
              item.testRun?.status === "not-run" && "not-run",
            )} />
          </button>;
        })}
        {githubReview && <button className={classNames("step-button", "review-step-button", finalReview && "active")} onClick={() => selectStep(null)}>
          <span className="step-number">{String(totalSteps).padStart(2, "0")}</span><span className="step-copy"><span>Review</span><small>Prepare GitHub draft</small></span>
        </button>}
      </nav>
      <main className="main-panel" inert={mobile && mobilePanel !== null}>
        <div className="step-content" ref={stepContentRef}>
          {finalReview ? <FinalReview renderThread={(comment) => <ReviewThread comment={comment} model={data} onSelectFile={(path, index, target) => {
            setReviewFileSteps((current) => ({ ...current, [path]: index })); openFile(path, target);
          }} />} /> : <><StepHeading step={step} />
          <StepContent key={step.id} step={step} selectedFile={selectedFile} onSelectFile={openFile} source={data.source} /></>}
        </div>
        <div className="step-pager">
          <div className="step-control" aria-label="Step navigation">
            <button aria-label="Previous step" disabled={stepIndex === 0} onClick={() => selectStep(data.steps[stepIndex - 1].id)}>
              <ChevronLeft aria-hidden="true" size={17} />
            </button>
            <span>{stepIndex + 1} / {totalSteps}</span>
            <button aria-label="Next step" disabled={stepIndex === totalSteps - 1} onClick={() => selectStep(data.steps[stepIndex + 1]?.id ?? null)}>
              <ChevronRight aria-hidden="true" size={17} />
            </button>
          </div>
        </div>
      </main>
      <DetailPanel
        reviewSummary={finalReview}
        onSelectReviewFile={(path, stepId, target) => {
          setReviewFileSteps((current) => ({ ...current, [path]: data.steps.findIndex((step) => step.id === stepId) }));
          openFile(path, target);
        }}
        step={data.steps[detailStepIndex]}
        source={data.source}
        selected={selected}
        selectedFile={selectedFile}
        onSelectFile={openFile}
        tabs={tabs}
        onReorderTab={reorderTab}
        fixtureRuns={newestFixtureRuns(data.steps, detailStepIndex)}
        onCloseFile={closeFile}
        scrollTarget={scrollTarget}
        detailWidth={detailWidth}
        collapsed={mobile ? mobilePanel !== "details" : rightCollapsed}
        mobile={mobile}
        panelRef={detailPanelRef}
        onToggle={() => mobile ? setMobilePanel(null) : setRightCollapsed((collapsed) => !collapsed)}
        onResizePointerDown={handleResizePointerDown}
        onResizePointerMove={handleResizePointerMove}
        onResizePointerUp={handleResizePointerUp}
        onResizeKeyDown={handleResizeKeyDown}
      />
    </div>
  </div></ReviewRuntimeContext.Provider></ReviewCommentsProvider>;
}
