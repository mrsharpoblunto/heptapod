import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Keep Excalidraw's browser globals isolated from the CLI and its callers. */
export async function exportDiagram(input: string, svg: string) {
  const source = resolve(input), destination = resolve(svg);
  if (source === destination) throw new Error("The SVG destination must differ from the Excalidraw source.");
  const fromSource = import.meta.url.endsWith(".ts");
  const worker = fileURLToPath(new URL(fromSource ? "./diagram-render.ts" : "./diagram-render.js", import.meta.url));
  const loader = fromSource ? [createRequire(import.meta.url).resolve("tsx/cli")] : [];
  await promisify(execFile)(process.execPath, [...loader, worker, source, destination], {
    timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  return { input: source, svg: destination };
}
