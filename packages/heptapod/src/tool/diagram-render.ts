import { readFileSync, writeFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createCanvas, type Canvas } from "@napi-rs/canvas";

async function main() {
  const scene = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (scene?.type !== "excalidraw" || scene.version !== 2 || !Array.isArray(scene.elements) || !scene.elements.length) {
    throw new Error("Expected an Excalidraw version 2 scene with a nonempty elements array.");
  }
  const types = new Set(["rectangle", "ellipse", "diamond", "arrow", "line", "text", "freedraw", "frame"]);
  for (const element of scene.elements) {
    if (!element || !types.has(element.type) || ![element.x, element.y, element.width, element.height].every(Number.isFinite)) {
      throw new Error("Diagram elements need a supported shape type and finite x, y, width, height. Images and embeds are not supported.");
    }
    if (element.type === "text" && typeof element.text !== "string") throw new Error("Text elements need text.");
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://excalidraw.com" });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLCanvasElement", "Image", "localStorage", "DOMParser", "devicePixelRatio"] as const) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true });
  }
  const canvases = new WeakMap<object, Canvas>();
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    value(this: HTMLCanvasElement, kind: string) {
      if (kind !== "2d") return null;
      let canvas = canvases.get(this);
      if (!canvas) { canvas = createCanvas(this.width || 1, this.height || 1); canvases.set(this, canvas); }
      return canvas.getContext("2d");
    },
  });
  try {
    // The package's declarations use extensionless internal imports, which
    // NodeNext cannot resolve. Keep this small boundary aligned with its API.
    const { exportToSvg } = await import("@excalidraw/utils") as unknown as {
      exportToSvg(options: { data: { elements: Record<string, unknown>[]; appState: Record<string, unknown>; files: null }; config: { padding: number; skipInliningFonts: true } }): Promise<SVGSVGElement>;
    };
    const svg = await exportToSvg({
      data: {
        elements: scene.elements.map((element: Record<string, unknown>) => ({ ...element, link: null })),
        appState: { ...scene.appState, exportEmbedScene: false, exportBackground: true, viewBackgroundColor: scene.appState?.viewBackgroundColor ?? "#ffffff" },
        files: null,
      },
      config: { padding: 24, skipInliningFonts: true },
    });
    // Portable fonts keep export entirely local; no CDN font fetches are needed.
    for (const text of svg.querySelectorAll("text")) text.setAttribute("font-family", "Arial, sans-serif");
    if (/NaN|Infinity/.test(svg.getAttribute("viewBox") ?? "")) throw new Error("The scene has invalid bounds.");
    writeFileSync(process.argv[3], svg.outerHTML + "\n");
  } finally { dom.window.close(); }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
