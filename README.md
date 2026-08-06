# CellMLForge CellML Editor

Single-page Vue application for editing CellML models in the browser, designed for GitHub Pages hosting.

## Quick Start

Use the live app: https://cellmlforge.github.io/cellml-editor/

Basic usage:

1. Open one or more CellML files:
	- Click **Open .cellml file**, or
	- Drag and drop `.cellml` files into the page.
2. Edit model XML:
	- Use the **Raw XML** view in the Monaco editor.
	- Changes are tracked in the current tab.
3. Preview equations:
	- Keep the cursor inside a MathML `<apply>` element that is a direct child of `<math>`.
	- The **Equation Preview** pane renders a human-readable math view beside the XML editor.
4. Export and save:
	- Use the save icon buttons in the XML toolbar area.
	- **Save as CellML 2** exports via `libcellml.js` printer.
	- **Save current XML** exports the current editor content as-is.

## Features

- CellMLForge-branded header and workspace shell
- Drag-and-drop `.cellml` file opening (multi-file supported)
- Multi-tab model editing workflow
- Per-model editor views:
	- Raw XML editing with Monaco editor
	- Simulation experiment configuration panel
	- Human-readable math-focused view derived from MathML blocks
- `libcellml.js` integration for parser-based validation notes

## Development

Prerequisites:

- Node.js 20+ (Node.js 24 recommended)

Install dependencies:

```bash
npm install
```

Run local dev server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## GitHub Pages Hosting

This project uses `base: "./"` in Vite config so generated assets resolve correctly from repository subpaths.

Typical publish flow:

1. Run `npm run build`.
2. Publish the `dist/` directory to your GitHub Pages branch (for example `gh-pages`) or Pages artifact workflow.

If using GitHub Actions Pages deployment, upload the `dist/` folder as the Pages artifact.
