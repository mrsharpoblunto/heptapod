import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportDiagram } from "../dist/tool/diagram.js";

const scene = {
  type: "excalidraw", version: 2,
  elements: [
    { id: "box", type: "rectangle", x: 0, y: 0, width: 180, height: 80 },
    { id: "label", type: "text", x: 12, y: 25, width: 150, height: 25, text: "Agent runs tests", fontFamily: 2, fontSize: 18 },
    { id: "arrow", type: "arrow", x: 185, y: 40, width: 100, height: 0, points: [[0, 0], [100, 0]], endArrowhead: "arrow" },
  ],
};

test("wrapped Excalidraw export renders shapes and labels without leaking browser globals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heptapod-diagram-"));
  const originalWindow = globalThis.window;
  try {
    const input = join(directory, "flow.excalidraw"), svg = join(directory, "flow.svg");
    writeFileSync(input, JSON.stringify(scene));
    assert.deepEqual(await exportDiagram(input, svg), { input, svg });
    const output = readFileSync(svg, "utf8");
    assert.match(output, /svg-source:excalidraw/);
    assert.match(output, /Agent runs tests/);
    assert.match(output, /<path/);
    assert.doesNotMatch(output, /NaN|Infinity|@font-face|<script/);
    assert.equal(globalThis.window, originalWindow);
    await assert.rejects(exportDiagram(input, input), /must differ/);
    writeFileSync(input, JSON.stringify({ ...scene, elements: [{ type: "rectangle", x: "bad" }] }));
    await assert.rejects(exportDiagram(input, svg), /finite x/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
