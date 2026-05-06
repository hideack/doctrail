# AGENTS.md

This repository contains DocTrail, a read-only Markdown viewer for macOS built with Tauri, React, and TypeScript.

## Start Here

- Read `docs/development.md` before changing behavior.
- Main frontend implementation: `src/App.tsx`
- Main styling: `src/styles.css`
- Tauri runtime and macOS open-file handling: `src-tauri/src/lib.rs`
- Tauri bundle, file association, CSP, asset protocol: `src-tauri/tauri.conf.json`
- Tauri permissions: `src-tauri/capabilities/default.json`

## Commands

```bash
npm install
npm run build
npm run tauri:build
npm run tauri:dev
```

`npm run build` verifies TypeScript and Vite. `npm run tauri:build` verifies the Rust side and produces the macOS app bundle.

## Implementation Notes

- Keep the app read-only. Do not add Markdown editing behavior unless explicitly requested.
- Do not enable raw HTML execution. `react-markdown` intentionally does not use `rehype-raw`.
- Mermaid blocks are rendered only for explicit `mermaid` code blocks or auto-detected Mermaid syntax starts.
- Relative Markdown images are resolved against the opened Markdown file directory and converted with Tauri `convertFileSrc`.
- Multiple open documents are represented by `DocumentTab[]`; the vertical file tab pane appears only when `tabs.length > 1`.
- Font scale is stored in `localStorage` under `doctrail.fontScale`.
- Toolbar display mode is stored in `localStorage` under `doctrail.toolbarMode`.
- Toolbar buttons use `lucide-react` icons; keep icon-only controls accessible with `aria-label` and `title`.
- macOS file association launches are bridged from Rust `RunEvent::Opened` to frontend event `open-files`.

## Build Artifacts

Generated directories such as `dist/`, `node_modules/`, and `src-tauri/target/` are build artifacts. Avoid editing them manually.
