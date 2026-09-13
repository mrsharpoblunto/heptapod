import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadHeptapodConfig, type HeptapodConfig } from "./config.js";
import { difftasticEnvironment, difftasticVersion } from "./difftastic.js";
import type { PatchFile, RenderModel, SemanticDiff, SemanticRange } from "./types.js";

const BYTE_LIMIT = 1_000_000;
const GRAPH_LIMIT = 3_000_000;
const CACHE_SCHEMA = 1;
const fallback = (reason: string): SemanticDiff => ({ status: "fallback", reason });
type ReadyDiff = Extract<SemanticDiff, { status: "ready" }>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Difftastic object");
  return value as Record<string, unknown>;
}

export function diffSourceLines(source: string): string[] {
  if (!source) return [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Validate the unstable upstream schema and normalize it at the ingestion boundary. */
export function parseDifftasticOutput(output: string, before: string, after: string): SemanticDiff {
  try {
    const parsed: unknown = JSON.parse(output);
    const file = object(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed);
    const language = file.language;
    if (typeof language !== "string" || !language || /text|binary|limit|error/i.test(language)) return fallback("Difftastic used a text or binary fallback");
    const lhs = diffSourceLines(before), rhs = diffSourceLines(after);
    const result: ReadyDiff = { status: "ready", language, unchanged: false, alignment: [], before: {}, after: {} };
    if (file.status === "unchanged") return { ...result, unchanged: true };
    if (file.status === "created" || file.status === "deleted") {
      const added = file.status === "created";
      if ((added ? before : after) !== "") throw new Error("Unexpected whole-file status");
      for (const [index, content] of (added ? rhs : lhs).entries()) {
        result.alignment.push(added ? [null, index + 1] : [index + 1, null]);
        (added ? result.after : result.before)[index + 1] = content.length ? [{ start: 0, end: content.length }] : [];
      }
      return result;
    }
    if (file.status !== "changed" || !Array.isArray(file.aligned_lines) || !Array.isArray(file.chunks)) throw new Error("Unsupported Difftastic schema");
    const cursor = [0, 0];
    for (const pair of file.aligned_lines) {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.every((line) => line === null)) throw new Error("Invalid alignment");
      const normalized = pair.map((line: unknown, side: number) => {
        if (line === null) return null;
        const source = side === 0 ? before : after;
        const lines = side === 0 ? lhs : rhs;
        if (typeof line !== "number" || !Number.isInteger(line) || line !== cursor[side]++) throw new Error("Invalid line order");
        // Difftastic includes the empty split segment following a terminal newline.
        if (line === lines.length && (source === "" || source.endsWith("\n"))) return null;
        if (line >= lines.length) throw new Error("Line outside snapshot");
        return line + 1;
      }) as [number | null, number | null];
      if (normalized.some((line) => line !== null)) result.alignment.push(normalized);
    }
    if (cursor[0] < lhs.length || cursor[1] < rhs.length) throw new Error("Incomplete alignment");
    for (const chunk of file.chunks) {
      if (!Array.isArray(chunk)) throw new Error("Invalid chunk");
      for (const entry of chunk) {
        const row = object(entry);
        for (const [key, lines, ranges] of [["lhs", lhs, result.before], ["rhs", rhs, result.after]] as const) {
          if (row[key] === undefined) continue;
          const side = object(row[key]);
          const line = side.line_number;
          if (typeof line !== "number" || !Number.isInteger(line) || line < 0 || line >= lines.length || !Array.isArray(side.changes)) throw new Error("Invalid changed line");
          // --tab-width=1 keeps offsets aligned with original tabs; Difftastic expands them to spaces.
          const bytes = Buffer.from(lines[line].replaceAll("\t", " "));
          const normalized: SemanticRange[] = ranges[line + 1] ??= [];
          for (const value of side.changes) {
            const change = object(value);
            const { start, end, content } = change;
            if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)
              || start < 0 || end <= start || end > bytes.length || typeof content !== "string"
              || bytes.subarray(start, end).toString("utf8") !== content) throw new Error("Invalid changed span");
            const prefix = bytes.subarray(0, start).toString("utf8");
            if (Buffer.byteLength(prefix) !== start) throw new Error("Invalid UTF-8 boundary");
            normalized.push({ start: prefix.length, end: prefix.length + content.length });
          }
          ranges[line + 1] = normalized.sort((a, b) => a.start - b.start).reduce<SemanticRange[]>((merged, range) => {
            const last = merged.at(-1);
            if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
            else merged.push({ ...range });
            return merged;
          }, []);
        }
      }
    }
    if (![...Object.values(result.before), ...Object.values(result.after)].some((ranges) => ranges.length)) throw new Error("Missing changed spans");
    return result;
  } catch {
    return fallback("Difftastic returned unsupported or invalid JSON");
  }
}

export function generateSemanticDiffs(
  repo: string, model: RenderModel, progress: (message: string) => void = () => {},
  options: NonNullable<HeptapodConfig["diff"]> = loadHeptapodConfig(repo)?.diff ?? {},
): void {
  if (options.engine === "standard") return;
  const files = model.steps.flatMap((step) => step.fileDiffs);
  if (!files.length) return;
  const executable = options.executable ?? "difft";
  const timeout = options.timeoutMs ?? 10_000;
  // User terminal settings must not suppress comments, changes, or JSON output.
  const env = difftasticEnvironment();
  env.DFT_UNSTABLE = "yes";
  let version: string | null = null;
  try {
    const result = spawnSync(executable, ["--version"], { cwd: repo, env, encoding: "utf8", timeout: Math.min(timeout, 3000), killSignal: "SIGKILL", maxBuffer: 4096 });
    if (!result.error && result.status === 0) version = difftasticVersion(result.stdout);
  } catch { /* An unusable executable must not block ingestion. */ }
  const cache = join(repo, "node_modules/.cache/heptapod/difftastic");
  const memo = new Map<string, SemanticDiff>();
  const metadata = model.diffGeneration = { engine: "difftastic" as const, version, ready: 0, fallback: 0 };
  const generate = (file: PatchFile): SemanticDiff => {
    if (file.beforeContent === undefined || file.afterContent === undefined) return fallback("Source snapshots are unavailable");
    const before = file.beforeContent ?? "", after = file.afterContent ?? "";
    if (before.includes("\0") || after.includes("\0") || /^(?:GIT binary patch|Binary files )/m.test(file.patch)) return fallback("Binary file");
    if (Math.max(Buffer.byteLength(before), Buffer.byteLength(after)) > BYTE_LIMIT) return fallback("File exceeds the structural diff size limit");
    if (!version) return fallback("Difftastic is not installed on the host or could not start; using standard diffs");
    const key = createHash("sha256").update(JSON.stringify([CACHE_SCHEMA, version, file.path, file.from, before, after, BYTE_LIMIT, GRAPH_LIMIT])).digest("hex");
    const cached = memo.get(key);
    if (cached) return cached;
    const cachePath = join(cache, `${key}.json`);
    let output: string | undefined;
    try { output = readFileSync(cachePath, "utf8"); } catch { /* A cache miss is normal. */ }
    if (output) {
      const parsed = parseDifftasticOutput(output, before, after);
      if (parsed.status === "ready") { memo.set(key, parsed); return parsed; }
    }
    let temporary: string | undefined;
    let result: SemanticDiff;
    try {
      temporary = mkdtempSync(join(tmpdir(), "heptapod-difft-"));
      const oldDirectory = join(temporary, "before"), newDirectory = join(temporary, "after");
      mkdirSync(oldDirectory); mkdirSync(newDirectory);
      const oldPath = join(oldDirectory, basename(file.from ?? file.path)), newPath = join(newDirectory, basename(file.path));
      writeFileSync(oldPath, before); writeFileSync(newPath, after);
      const diff = spawnSync(executable, ["--display", "json", "--color", "never", "--tab-width", "1", "--strip-cr", "on",
        "--byte-limit", String(BYTE_LIMIT), "--graph-limit", String(GRAPH_LIMIT), "--parse-error-limit", "0", "--", oldPath, newPath],
      { cwd: repo, env, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
      result = diff.error || diff.status !== 0
        ? fallback((diff.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? "Difftastic timed out" : "Difftastic failed")
        : parseDifftasticOutput(diff.stdout, before, after);
      if (result.status === "ready") {
        // The review payload is the retrieval cache; this additional cache accelerates re-ingestion.
        const pending = `${cachePath}.${process.pid}.tmp`;
        try {
          mkdirSync(cache, { recursive: true });
          // Write in the cache filesystem before renaming, since tmpdir may be another volume.
          writeFileSync(pending, diff.stdout);
          renameSync(pending, cachePath);
        } catch { /* Cache persistence must not prevent displaying a successful diff. */ }
        finally { try { rmSync(pending, { force: true }); } catch { /* Best-effort cache cleanup. */ } }
      }
    } catch {
      result = fallback("Could not prepare Difftastic inputs");
    } finally {
      if (temporary) { try { rmSync(temporary, { recursive: true, force: true }); } catch { /* Best-effort temporary cleanup. */ } }
    }
    memo.set(key, result);
    return result;
  };
  for (const [index, file] of files.entries()) {
    progress(`Generating structural diffs ${index + 1}/${files.length}: ${file.path}`);
    file.semanticDiff = generate(file);
    metadata[file.semanticDiff.status === "ready" ? "ready" : "fallback"] += 1;
  }
  progress(`Structural diffs ready: ${metadata.ready}; standard fallbacks: ${metadata.fallback}`);
}
