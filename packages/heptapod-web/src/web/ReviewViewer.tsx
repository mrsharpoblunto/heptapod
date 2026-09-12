"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ExternalLink,
  FoldVertical,
  Maximize2,
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
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ElementType,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import hljs from "highlight.js/lib/common";
import type {
  Callsite,
  Check,
  Evidence,
  PatchFile,
  RenderModel,
  RenderStep,
  TestFixtureRun,
} from "@thestraylight/heptapod/types";
import {
  GitHubIcon,
} from "./GitHubIdentity";
import { useReviewBackdropState } from "./PersistentBackdrop";
import { ReviewHeader } from "./ReviewHeader";

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

function HighlightedCode({ source, language }: { source: string; language?: string }): ReactNode {
  return <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedHtml(source, language) }} />;
}

function Inline({
  text,
  files,
  onSelectFile,
}: {
  text: string;
  files: PatchFile[];
  onSelectFile?: (file: string) => void;
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
        return <FileLink file={file.path} active={false} inline onSelect={onSelectFile} key={index} />;
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
}: {
  source: string;
  files?: PatchFile[];
  onSelectFile?: (file: string) => void;
}): ReactNode {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
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
      const Tag = `h${Math.min(heading[1].length + 1, 5)}` as ElementType;
      blocks.push(<Tag key={blocks.length}><Inline text={heading[2]} files={files} onSelectFile={onSelectFile} /></Tag>);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^[-*]\s+/, ""));
      blocks.push(<ul key={blocks.length}>{items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item} files={files} onSelectFile={onSelectFile} /></li>)}</ul>);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) items.push(lines[index++].replace(/^\d+\.\s+/, ""));
      blocks.push(<ol key={blocks.length}>{items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item} files={files} onSelectFile={onSelectFile} /></li>)}</ol>);
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith("> ")) quote.push(lines[index++].slice(2));
      blocks.push(<blockquote key={blocks.length}><Inline text={quote.join(" ")} files={files} onSelectFile={onSelectFile} /></blockquote>);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s|^```|^[-*]\s+|^\d+\.\s+|^>\s+/.test(lines[index])) {
      paragraph.push(lines[index++].trim());
    }
    blocks.push(<p key={blocks.length}><Inline text={paragraph.join(" ")} files={files} onSelectFile={onSelectFile} /></p>);
  }
  return <div className="markdown">{blocks}</div>;
}

function EvidenceGallery({ evidence }: { evidence: Evidence[] }): ReactNode {
  const { reviewId } = useContext(ReviewRuntimeContext);
  if (evidence.length === 0) return null;
  return <div className="evidence-grid">{evidence.map((item) => {
    if (item.kind === "image") return <a href={item.sourceUrl ?? item.url} target="_blank" rel="noreferrer" key={item.url}>
      <img src={item.url} alt={item.label} />
    </a>;
    if (item.kind === "video") {
      const assetId = item.url.match(/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})/i)?.[1];
      const videoUrl = reviewId && assetId
        ? `/api/reviews/${encodeURIComponent(reviewId)}/github-media/${assetId}`
        : item.url;
      return <figure className="evidence-video" key={item.url}>
        <video controls playsInline preload="metadata" src={videoUrl}>
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

export function DiffView({
  filePath,
  patch,
  compact = false,
  scrollTarget,
  beforeContent,
  afterContent,
  githubFileUrl,
}: {
  filePath: string;
  patch: string;
  compact?: boolean;
  scrollTarget?: DiffTarget | null;
  beforeContent?: string | null;
  afterContent?: string | null;
  githubFileUrl?: string | null;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
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
    return <div className={classNames(`diff-line diff-${line.type}`, targetMatch.keys.has(line.key) && "diff-target")} data-diff-key={line.key} key={line.key}>
      {pureAddition || unchanged
        ? <span className="line-number">{line.next ?? ""}</span>
        : pureDeletion
          ? <span className="line-number">{line.old ?? ""}</span>
          : <><span className="line-number">{line.old ?? ""}</span><span className="line-number">{line.next ?? ""}</span></>}
      <code>{marker && <span className="diff-marker">{marker}</span>}<span className="hljs" dangerouslySetInnerHTML={{ __html: highlightedHtml(content, language) }} /></code>
    </div>;
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

function ChangeIcon({ change }: { change: "added" | "removed" | "changed" }): ReactNode {
  return <span className="test-change-icon" role="img" aria-label={change}>
    {change === "added" && <Plus aria-hidden="true" size={13} />}
    {change === "removed" && <Minus aria-hidden="true" size={13} />}
    {change === "changed" && <RefreshCw aria-hidden="true" size={12} />}
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
}: {
  run: TestFixtureRun;
  active: boolean;
  onSelectFile: (file: string) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const separator = run.file.lastIndexOf("/");
  const directory = separator === -1 ? "" : run.file.slice(0, separator + 1);
  const filename = separator === -1 ? run.file : run.file.slice(separator + 1);
  return <div className={classNames("test-fixture-run", expanded && "expanded")}>
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
  </div>;
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
      <div className="eyebrow">Tests</div>
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
  inline = false,
  change,
}: {
  file: string;
  label?: string;
  active: boolean;
  onSelect: (file: string) => void;
  connected?: boolean;
  connectedCollapsed?: boolean;
  inline?: boolean;
  change?: "added" | "removed" | "changed";
}): ReactNode {
  const separator = file.lastIndexOf("/");
  const directory = separator === -1 ? "" : file.slice(0, separator + 1);
  const filename = separator === -1 ? file : file.slice(separator + 1);
  if (inline) return <button className="file-link file-link-inline" onClick={() => onSelect(file)} title={file}>
    <strong className="file-link-filename">{filename}</strong>
  </button>;
  return <button className={classNames("file-link", connected && "file-link-connected", connectedCollapsed && "connected-collapsed", active && "active", change && `test-case-${change}`)} onClick={() => onSelect(file)} title={file}>
    {change && <ChangeIcon change={change} />}
    <span className="file-link-copy">
      {label && <span className="file-link-label">{label}</span>}
      <span className="file-link-path">
        {directory && <span className="file-link-directory">{directory}</span>}
        <strong className="file-link-filename">{filename}</strong>
      </span>
    </span>
  </button>;
}

function StepHeading({ step }: { step: RenderStep }): ReactNode {
  return <header className="step-heading">
    <div className="eyebrow">Step {step.number} · {kindLabel(step.kind)}</div>
    <h1>{step.title}</h1>
    {step.patch && <div className="diff-stats"><span>+{step.stats.additions}</span><span>−{step.stats.deletions}</span><span>{step.stats.files} {step.stats.files === 1 ? "file" : "files"}</span></div>}
  </header>;
}

function allStepFiles(step: RenderStep): PatchFile[] {
  return [...step.fileDiffs, ...(step.referenceFiles ?? [])];
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
  const areas = step.testAreas ?? [];
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  return <>
    {step.body && <Markdown source={step.body} files={allStepFiles(step)} onSelectFile={onSelectFile} />}
    <div className="test-areas">
      {areas.map((area, index) => <section className="test-area" key={`${area.name}-${index}`}>
        <div className="test-area-description">
          <div className="test-area-heading"><h3>{area.name}</h3><span className="test-type-badge">Automated test</span></div>
          <p>{area.description}</p>
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
  const callsiteChange = (file: string, declared?: "added" | "removed" | "changed") => {
    if (declared) return declared;
    const snapshot = step.fileDiffs.find((candidate) => candidate.path === file);
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
          {item.description && <p>{item.description}</p>}
          {(item.before || item.after) && <div className="before-after">
            {item.before && <div><span>Before</span><Markdown source={item.before} files={allStepFiles(step)} onSelectFile={onSelectFile} /></div>}
            {item.after && <div><span>After</span><Markdown source={item.after} files={allStepFiles(step)} onSelectFile={onSelectFile} /></div>}
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

function DetailPanel({
  step,
  source,
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
}: StepViewProps & {
  source: RenderModel["source"];
  tabs: string[];
  onReorderTab: (from: string, to: string) => void;
  fixtureRuns: TestFixtureRun[];
  onCloseFile: (file: string) => void;
  scrollTarget: DiffTarget | null;
  detailWidth: number;
  collapsed: boolean;
  onToggle: () => void;
  onResizePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onResizePointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onResizePointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
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
  if (collapsed) return toggle;
  const selected = allStepFiles(step).find((file) => file.path === selectedFile);
  const selectedGitHubUrl = selected ? githubFileUrl(source, selected) : null;
  return <aside className="detail-panel">
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
        >Step summary</button> : <div
          {...dragHandlers(file)}
          className={classNames("file-tab", selectedFile === file && "active", draggingTab === file && "tab-dragging", dropTarget === file && "tab-drop-target")}
          key={file}
        >
          <button
            aria-selected={selectedFile === file}
            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
            aria-description="Drag to reorder, or press Alt and an arrow key."
            onClick={() => onSelectFile(file)}
            onKeyDown={(event) => moveWithKeyboard(event, file)}
            role="tab"
            title={file}
          >{file.split("/").at(-1)}</button>
          <button aria-label={`Close ${file}`} className="close-tab" onClick={() => onCloseFile(file)} title={`Close ${file}`}><X aria-hidden="true" size={13} /></button>
        </div>)}
      </div>
      {toggle}
    </div>
    {selectedFile === null && <div className="detail-panel-content">
      <Checks step={step} fixtureRuns={fixtureRuns} selectedFile={selectedFile} onSelectFile={onSelectFile} />
      {step.fileDiffs.length > 0 && <section className="changed-files">
        <div className="eyebrow">Files in this step</div>
        <div className="file-pills">{step.fileDiffs.map((file) => <FileLink file={file.path} active={false} onSelect={onSelectFile} key={file.path} />)}</div>
      </section>}
    </div>}
    {selected && <div className="detail-panel-content file-tab-content">
      <div className="tab-diff">
        <DiffView
          filePath={selected.path}
          patch={selected.patch}
          compact
          scrollTarget={scrollTarget}
          beforeContent={selected.beforeContent}
          afterContent={selected.afterContent}
          githubFileUrl={selectedGitHubUrl}
        />
      </div>
    </div>}
  </aside>;
}

export function ReviewViewer({
  data,
  reviewId,
  updatedAt,
}: {
  data: RenderModel;
  reviewId?: string;
  updatedAt: string;
}): ReactNode {
  useReviewBackdropState("ready");
  const [stepIndex, setStepIndex] = useState(0);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [detailWidth, setDetailWidth] = useState(420);
  const [tabs, setTabs] = useState<string[]>([""]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<DiffTarget | null>(null);
  const [detailPreferencesLoaded, setDetailPreferencesLoaded] = useState(false);
  const step = data.steps[stepIndex];
  const stepContentRef = useRef<HTMLDivElement>(null);
  const initializedFromLocation = useRef(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

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
    if (!file) {
      setSelectedFile(null);
      setScrollTarget(null);
      return;
    }
    setTabs((files) => files.includes(file) ? files : [...files, file]);
    setSelectedFile(file);
    setScrollTarget(target ? { ...target } : null);
    setRightCollapsed(false);
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
      initializedFromLocation.current = true;
      const requestedIndex = data.steps.findIndex((item) => `#${item.id}` === window.location.hash);
      if (requestedIndex > 0) {
        setStepIndex(requestedIndex);
        return;
      }
    }
    setTabs([""]);
    setSelectedFile(null);
    setScrollTarget(null);
    stepContentRef.current?.scrollTo({ top: 0 });
    history.replaceState(null, "", `#${step.id}`);
    document.title = `${step.number}. ${step.title} — ${data.title}`;
  }, [data.steps, data.title, step]);

  return <ReviewRuntimeContext.Provider value={{ reviewId }}><div className="app-shell">
    <header className="topbar">
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
      }} />
    </header>
    <div
      className="workspace"
      style={{
        gridTemplateColumns: `276px minmax(480px, 1fr)${rightCollapsed ? "" : ` ${detailWidth}px`}`,
        "--detail-width": `${rightCollapsed ? 0 : detailWidth}px`,
      } as CSSProperties}
    >
      <nav className="step-nav" aria-label="Narrative steps">
        {data.steps.map((item, index) => {
          return <button className={classNames("step-button", index === stepIndex && "active")} onClick={() => setStepIndex(index)} key={item.id}>
            <span className="step-number">{String(index + 1).padStart(2, "0")}</span>
            <span className="step-copy"><span>{item.title}</span><small>{kindLabel(item.kind)}</small></span>
            <span className={classNames(
              "step-dot",
              (item.testRun?.status === "failing" || item.testRun?.status === "timed-out") && "has-failure",
              item.testRun?.status === "not-run" && "not-run",
            )} />
          </button>;
        })}
      </nav>
      <main className="main-panel">
        <div className="step-content" ref={stepContentRef}>
          <StepHeading step={step} />
          <StepContent key={step.id} step={step} selectedFile={selectedFile} onSelectFile={openFile} source={data.source} />
        </div>
        <div className="step-pager">
          <div className="step-control" aria-label="Step navigation">
            <button aria-label="Previous step" disabled={stepIndex === 0} onClick={() => setStepIndex((index) => index - 1)}>
              <ChevronLeft aria-hidden="true" size={17} />
            </button>
            <span>{stepIndex + 1} / {data.steps.length}</span>
            <button aria-label="Next step" disabled={stepIndex === data.steps.length - 1} onClick={() => setStepIndex((index) => index + 1)}>
              <ChevronRight aria-hidden="true" size={17} />
            </button>
          </div>
        </div>
      </main>
      <DetailPanel
        step={step}
        source={data.source}
        selectedFile={selectedFile}
        onSelectFile={openFile}
        tabs={tabs}
        onReorderTab={reorderTab}
        fixtureRuns={newestFixtureRuns(data.steps, stepIndex)}
        onCloseFile={closeFile}
        scrollTarget={scrollTarget}
        detailWidth={detailWidth}
        collapsed={rightCollapsed}
        onToggle={() => setRightCollapsed((collapsed) => !collapsed)}
        onResizePointerDown={handleResizePointerDown}
        onResizePointerMove={handleResizePointerMove}
        onResizePointerUp={handleResizePointerUp}
        onResizeKeyDown={handleResizeKeyDown}
      />
    </div>
  </div></ReviewRuntimeContext.Provider>;
}
