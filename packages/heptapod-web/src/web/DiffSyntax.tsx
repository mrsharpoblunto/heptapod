import { Fragment, type ReactNode } from "react";
import hljs from "highlight.js/lib/common";
import type { SemanticRange } from "@thestraylight/heptapod-core/types";

export function highlightedHtml(source: string, language?: string): string {
  if (!source) return "";
  try {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(source, { language }).value
      : hljs.highlightAuto(source).value;
  } catch {
    return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }
}

interface SyntaxRun {
  start: number;
  end: number;
  scopes: string[];
}
export type SyntaxLine = SyntaxRun[];

/** Highlight the complete snapshot so comments, strings, and embedded languages
 * keep their context across both diff boundaries and physical source lines. */
export function highlightSourceLines(source: string, language?: string): SyntaxLine[] {
  const html = highlightedHtml(source.replace(/\r\n/g, "\n"), language);
  const lines: SyntaxLine[] = [[]];
  const scopes: string[] = [];
  let offset = 0;
  // highlight.js emits escaped text and nested spans. Decode text once to recover
  // the original UTF-16 offsets; the renderer always escapes source via React.
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    if (match[1] !== undefined) scopes.push(match[1]);
    else if (match[0] === "</span>") scopes.pop();
    else {
      const text = match[2].replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => entities[entity]);
      for (const [index, part] of text.split("\n").entries()) {
        if (index > 0) { lines.push([]); offset = 0; }
        if (part.length) lines.at(-1)!.push({ start: offset, end: offset + part.length, scopes: [...scopes] });
        offset += part.length;
      }
    }
  }
  return lines;
}

export function SyntaxCode({ content, changes = [], syntax, language }: {
  content: string;
  changes?: SemanticRange[];
  syntax?: SyntaxLine;
  language?: string;
}): ReactNode {
  const runs = syntax ?? highlightSourceLines(content, language)[0];
  const slice = (start: number, end: number) => runs.flatMap((run, index) => {
    const from = Math.max(start, run.start), to = Math.min(end, run.end);
    if (from >= to) return [];
    const text = content.slice(from, to);
    return [<Fragment key={index}>{run.scopes.reduceRight<ReactNode>((child, scope) => <span className={scope}>{child}</span>, text)}</Fragment>];
  });
  let cursor = 0;
  const parts: ReactNode[] = [];
  for (const range of changes) {
    if (range.start > cursor) parts.push(<Fragment key={`plain-${cursor}`}>{slice(cursor, range.start)}</Fragment>);
    parts.push(<mark className="diff-token-change" key={`change-${range.start}`}>{slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < content.length) parts.push(<Fragment key={`plain-${cursor}`}>{slice(cursor, content.length)}</Fragment>);
  return <span className="hljs">{parts}</span>;
}
