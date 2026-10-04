# Excalidraw references

Use the repository-local wrapper to export an Excalidraw version 2 JSON scene to SVG:

```bash
pnpm exec heptapod diagram --input <metadata-directory>/visuals/flow.excalidraw --svg <metadata-directory>/visuals/flow.svg --output ndjson
```

Create the destination directory first. The wrapper calls `@excalidraw/utils`'s `exportToSvg`; no browser installation or remote service is needed. Supported element types are rectangle, ellipse, diamond, arrow, line, text, freedraw, and frame. Supply finite `x`, `y`, `width`, and `height` for each element. Text also needs `text`. Use full Excalidraw element fields for bindings, groups, arrowheads, or complex layouts; the library restores omitted defaults. Images, embedded web content, and element hyperlinks are not exported. Fonts use a portable Arial/sans-serif fallback so export needs no network requests.

A small starting scene (save as `flow.excalidraw`):

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "heptapod",
  "elements": [
    { "id": "agent", "type": "rectangle", "x": 0, "y": 0, "width": 180, "height": 80, "backgroundColor": "#dbeafe" },
    { "id": "agent-label", "type": "text", "x": 20, "y": 25, "width": 140, "height": 25, "text": "Agent runs tests", "fontSize": 18, "fontFamily": 2 },
    { "id": "evidence", "type": "arrow", "x": 190, "y": 40, "width": 100, "height": 0, "points": [[0, 0], [100, 0]], "endArrowhead": "arrow" },
    { "id": "ingest", "type": "rectangle", "x": 300, "y": 0, "width": 200, "height": 80, "backgroundColor": "#dcfce7" },
    { "id": "ingest-label", "type": "text", "x": 315, "y": 25, "width": 175, "height": 25, "text": "Ingest checks evidence", "fontSize": 16, "fontFamily": 2 }
  ],
  "appState": { "viewBackgroundColor": "#ffffff" },
  "files": {}
}
```

Keep each diagram focused on the step's key relationship or algorithm. Label arrows with calls, data, or ordering; for a migration distinguish before and after clearly. Embed the exported SVG on its own line in the step body, for example `![Agent submits results for validation](../visuals/flow.svg)`, and explain its relevance in nearby prose. Inspect the rendered export before ingesting; JSON validity does not guarantee a readable diagram.

API references: [Excalidraw utility package](https://github.com/excalidraw/excalidraw/tree/master/packages/utils) and [scene JSON schema](https://docs.excalidraw.com/docs/codebase/json-schema/).
