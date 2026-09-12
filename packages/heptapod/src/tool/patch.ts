import type { PatchFile, PatchStats } from "./types.js";

function decodeGitPath(value: string): string | null {
  let text = value.trim();
  if (text === "/dev/null") return null;
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).replace(/\\([0-7]{1,3}|[abfnrtv\\"])/g, (_, escape: string) => {
      if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
      return { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' }[escape] ?? escape;
    });
  }
  return text.replace(/^[ab]\//, "");
}

function pathFromSection(section: string): string {
  const lines = section.split("\n");
  const added = lines.find((line) => line.startsWith("+++ "));
  if (added) {
    const path = decodeGitPath(added.slice(4));
    if (path) return path;
  }
  const removed = lines.find((line) => line.startsWith("--- "));
  if (removed) {
    const path = decodeGitPath(removed.slice(4));
    if (path) return path;
  }
  const renamed = lines.find((line) => line.startsWith("rename to "));
  if (renamed) return decodeGitPath(renamed.slice("rename to ".length)) ?? renamed;
  const copied = lines.find((line) => line.startsWith("copy to "));
  if (copied) return decodeGitPath(copied.slice("copy to ".length)) ?? copied;
  const binary = lines.find((line) => line.startsWith("Binary files "));
  if (binary) {
    const marker = binary.lastIndexOf(" and b/");
    if (marker !== -1) return binary.slice(marker + 7, -" differ".length);
  }
  const header = lines[0] ?? "";
  const quotedMarker = header.lastIndexOf(' "b/');
  if (quotedMarker !== -1) return decodeGitPath(header.slice(quotedMarker + 1)) ?? header;
  const marker = header.lastIndexOf(" b/");
  return marker === -1
    ? header.replace(/^diff --git /, "")
    : (decodeGitPath(header.slice(marker + 1)) ?? header);
}

export function splitPatchFiles(patch: string): PatchFile[] {
  const starts: number[] = [];
  const expression = /^diff --git /gm;
  let match;
  while ((match = expression.exec(patch)) !== null) starts.push(match.index);
  return starts.map((start, index) => {
    const text = patch.slice(start, starts[index + 1] ?? patch.length).replace(/\n+$/, "\n");
    return { path: pathFromSection(text), patch: text };
  });
}

export function patchStats(patch: string): PatchStats {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions, files: splitPatchFiles(patch).length };
}
