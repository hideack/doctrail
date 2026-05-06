# DocTrail Development Notes

DocTrail is a macOS Markdown viewer. It is intentionally read-only and optimized for opening local Markdown files, navigating outlines, previewing rich Markdown, rendering Mermaid diagrams, switching between multiple open documents, and searching the active document.

## Tech Stack

- Tauri v2 for the macOS app shell and native file access
- React + TypeScript for the UI
- `react-markdown` for Markdown rendering
- `remark-gfm` for GitHub Flavored Markdown
- `rehype-highlight` and `highlight.js` for code highlighting
- `mermaid` for Mermaid diagrams
- `lucide-react` for toolbar icons

## Project Layout

```text
src/
  App.tsx          Main app state, tabs, Markdown parsing, rendering, search, file open flows
  main.tsx         React entry point
  styles.css      Application styling and theme tokens

src-tauri/
  src/lib.rs       Tauri setup, macOS open-file event bridge, pending open files command
  src/main.rs      Native entry point
  tauri.conf.json  Window, CSP, bundle, file association, asset protocol
  capabilities/    Tauri permission scopes
  icons/icon.png   Minimal app icon used by the Tauri bundle
```

## Core Frontend Flows

### Opening Files

All file-opening paths should eventually call `loadFiles(paths)` or `loadFile(path)` in `src/App.tsx`.

Supported entry points:

- Toolbar `Open`
- Toolbar `Reload`
- Tauri drag and drop via `getCurrentWebview().onDragDropEvent`
- macOS `Open With` / file association via the `open-files` event emitted by Rust
- Pending files collected before the frontend listener is ready via `take_pending_open_files`

Supported Markdown extensions:

```text
.md, .markdown, .mdown, .mkd
```

### Document Tabs

Open documents are stored in `tabs: DocumentTab[]`.

```ts
type DocumentTab = {
  id: string;
  path: string;
  name: string;
  markdown: string;
};
```

The tab `id` is the normalized file path. Opening an already-open file replaces that tab's content and activates it.

UI behavior:

- One open file: no file tab pane is shown.
- Two or more open files: a narrow vertical file tab pane appears to the left of the outline pane.
- The tab displays only the file name.
- The full path is exposed via the button `title` tooltip.
- Closing the active tab activates the next tab at the same index, or the previous one if the closed tab was last.

Only the active tab participates in outline, search, image base path, Mermaid rendering, and reload.

### macOS File Association

`src-tauri/tauri.conf.json` declares `fileAssociations` for Markdown extensions. This writes `CFBundleDocumentTypes` into the generated `Info.plist`.

Native open events are handled in `src-tauri/src/lib.rs`:

- CLI args are collected during setup for `open -a DocTrail file.md` style launches.
- macOS `RunEvent::Opened` is converted from file URLs to paths.
- Paths are stored in `PendingOpenFiles` and emitted to the frontend as `open-files`.

The frontend:

- Calls `take_pending_open_files` once after startup.
- Listens for `open-files`.
- Opens all supported Markdown paths and activates the first one from that batch.

### Outline

`extractHeadings(markdown)` parses ATX headings from Markdown text:

- Included levels: `#`, `##`, `###`, `####`
- Fenced code blocks are ignored.
- IDs are deterministic slug values with numeric suffixes for duplicates.
- The flat list drives heading `id` attributes in the rendered preview.
- The tree list drives the sidebar outline.

Current section highlighting is driven by the preview scroll container. On scroll, the active heading is calculated as the last heading above the current scroll marker, and the matching outline item is scrolled into view in the sidebar.

### Search

Search state is stored in `query`, `searchMatches`, and `activeMatchIndex`.

- `findSearchMatches` scans the raw Markdown text and maps matches to heading ranges.
- A small rehype plugin from `createSearchPlugin(query)` wraps rendered text matches in `<mark class="search-hit">`.
- Enter / Shift+Enter moves forward and backward.
- Matching sections are highlighted in the outline.

### Mermaid

Mermaid is rendered by `MermaidBlock`.

Supported detection:

- Explicit fenced code block language: ```` ```mermaid ````
- Auto-detected language-less blocks whose first meaningful line starts with known Mermaid diagram keywords such as `flowchart`, `graph`, `sequenceDiagram`, `classDiagram`, `stateDiagram`, `erDiagram`, `gantt`, or `pie`

Syntax errors render an error panel and the original source instead of breaking the preview.

Mermaid uses:

```ts
securityLevel: "strict"
theme: darkMode ? "dark" : "default"
```

### Images

Markdown image paths are resolved relative to the current Markdown file directory.

Implementation:

- `dirname(filePath)` determines the base directory.
- `resolveRelativePath(baseDir, src)` normalizes relative paths.
- Local file URLs are converted with `convertFileSrc`.

Remote URLs, `data:`, `blob:`, and already converted asset URLs are passed through.

### Font Size

Preview font scaling is controlled by `fontScale`.

- Range: 80% to 150%
- Step: 10%
- Default: 100%
- Storage key: `doctrail.fontScale`
- Toolbar controls: zoom-out icon, percentage reset, zoom-in icon
- Shortcuts:
  - `Command +` or `Command =`: increase
  - `Command -`: decrease
  - `Command 0`: reset

CSS applies this through `--preview-font-size` on `.preview-shell`, consumed by `.markdown-body`.

### Toolbar

The top toolbar uses icon-only controls with accessible labels and hover titles.

- Open: folder icon
- Reload: refresh icon
- Font size: zoom icons and percentage reset
- Toolbar display mode: pin icon

Toolbar display mode is controlled by `toolbarMode`.

- Values: `always` or `auto`
- Default: `always`
- Storage key: `doctrail.toolbarMode`

In `auto` mode, `.toolbar-auto` makes the preview layout fill the window and overlays the toolbar. The toolbar becomes visible when the pointer moves near the top of the window or over `.toolbar-hover-zone`.

## Security Choices

- Raw HTML execution is not enabled.
- The app does not use `rehype-raw`.
- Mermaid uses strict security mode.
- CSP is configured in `tauri.conf.json`.
- File-system reads are scoped by Tauri capabilities.
- The app is read-only and does not write Markdown files.

## Tauri Configuration

Important files:

- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`
- `src-tauri/Cargo.toml`

Notable Tauri settings:

- `dragDropEnabled: true`
- `assetProtocol.enable: true`
- `assetProtocol.scope: ["**"]`
- Markdown `fileAssociations`
- `protocol-asset` feature in `Cargo.toml`

## Build and Verification

Install dependencies:

```bash
npm install
```

Verify frontend:

```bash
npm run build
```

Build macOS app:

```bash
npm run tauri:build
```

Build outputs:

```text
src-tauri/target/release/bundle/macos/DocTrail.app
src-tauri/target/release/bundle/dmg/DocTrail_0.1.0_aarch64.dmg
```

Test file association manually:

```bash
open -a /Users/hideack/pj/terry/doctrail/src-tauri/target/release/bundle/macos/DocTrail.app /path/to/file.md
```

Register with LaunchServices if Finder does not show the app:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Users/hideack/pj/terry/doctrail/src-tauri/target/release/bundle/macos/DocTrail.app
```

## Known Limitations

- Multiple Markdown files can be open, but only one active document is displayed at a time.
- Search highlights rendered text nodes; it does not highlight inside Mermaid SVG output.
- Markdown heading parsing is purpose-built for ATX headings and does not currently parse Setext headings.
- Large documents may need optimization if search or Markdown rendering becomes slow.
- The Mermaid bundle is large; code splitting could be considered later.

## Change Guidelines

- Keep new behavior routed through existing helpers when possible.
- Keep security posture read-only and no raw HTML unless explicitly revisited.
- After changing frontend code, run `npm run build`.
- After changing Tauri config, permissions, Rust code, file association, or native file handling, run `npm run tauri:build`.
- Avoid manual edits in generated folders: `dist/`, `node_modules/`, `src-tauri/target/`.
