import { posix } from "node:path";

const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export function repositoryPathFromMarkdownHref(href: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  const normalized = posix.normalize(decoded.replace(/^\.\//, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("\\")) return null;
  return normalized;
}

export function extractRepositoryFileReferences(markdown: string): string[] {
  const paths = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const path = repositoryPathFromMarkdownHref(match[2]);
    if (path) paths.add(path);
  }
  return [...paths];
}

export function rewriteRepositoryFileLinks(markdown: string, resolvedPaths: ReadonlySet<string>): string {
  return markdown.replace(MARKDOWN_LINK, (match, label: string, href: string) => {
    const path = repositoryPathFromMarkdownHref(href);
    return path && resolvedPaths.has(path)
      ? `[${label}](heptapod-file:${encodeURIComponent(path)})`
      : match;
  });
}
