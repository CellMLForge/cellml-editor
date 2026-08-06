# CellMLForge CellML Editor

Single-page Vue application for editing CellML models in the browser, designed for GitHub Pages hosting.

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
