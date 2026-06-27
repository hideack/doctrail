import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { ChevronDown, ChevronRight, FolderOpen, FolderTree, Pin, PinOff, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import mermaid from "mermaid";
import "highlight.js/styles/github-dark.css";

type OutlineItem = {
  id: string;
  text: string;
  level: 1 | 2 | 3 | 4;
  line: number;
  children: OutlineItem[];
};

type FlatHeading = Omit<OutlineItem, "children">;

type SearchMatch = {
  id: string;
  index: number;
  end: number;
  headingId: string | null;
};

type DocumentTab = {
  id: string;
  path: string;
  name: string;
  markdown: string;
};

type ToolbarMode = "always" | "auto";

type FileNode = {
  name: string;
  path: string;
  is_directory: boolean;
  children: FileNode[];
};

const SAMPLE_MARKDOWN = `# DocTrail

Open a Markdown file to begin.

## Features

- GitHub Flavored Markdown
- Code highlighting
- Mermaid diagrams
- Outline navigation
- Full-text search

\`\`\`mermaid
flowchart LR
  A[Open Markdown] --> B[Parse Headings]
  B --> C[Preview]
\`\`\`
`;

const DEFAULT_FONT_SCALE = 100;
const FONT_SCALE_STEP = 10;
const MIN_FONT_SCALE = 80;
const MAX_FONT_SCALE = 150;
const TOOLBAR_MODE_KEY = "doctrail.toolbarMode";

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section"
  );
}

function stripInlineMarkdown(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#]/g, "")
    .trim();
}

function extractHeadings(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const flat: FlatHeading[] = [];
  const slugCounts = new Map<string, number>();
  let fenced = false;

  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;

    const match = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return;

    const text = stripInlineMarkdown(match[2]);
    const base = slugify(text);
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);

    flat.push({
      id: count === 0 ? base : `${base}-${count}`,
      text,
      level: match[1].length as 1 | 2 | 3 | 4,
      line: index,
    });
  });

  const roots: OutlineItem[] = [];
  const stack: OutlineItem[] = [];

  flat.forEach((heading) => {
    const item: OutlineItem = { ...heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(item);
    } else {
      stack[stack.length - 1].children.push(item);
    }
    stack.push(item);
  });

  return { flat, tree: roots };
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

function dirname(path: string) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function basename(path: string) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function resolveRelativePath(baseDir: string | null, src?: string) {
  if (!src || !baseDir) return src ?? "";
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return src;
  if (src.startsWith("/")) return convertFileSrc(src);

  const parts = `${baseDir}/${src}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return convertFileSrc(`/${resolved.join("/")}`);
}

function isMarkdownPath(path: string) {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

function isMermaidCode(language: string | undefined, code: string) {
  if (language === "mermaid") return true;

  const firstMeaningfulLine = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("%%"));

  if (!firstMeaningfulLine) return false;

  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|c4Context|c4Container|c4Component|c4Dynamic|sankey-beta|xychart-beta|block-beta)\b/i.test(
    firstMeaningfulLine,
  );
}

function collectText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return collectText(props?.children);
  }
  return "";
}

function createSearchPlugin(query: string) {
  return () => (tree: unknown) => {
    if (!query.trim()) return;
    const needle = query.toLowerCase();

    const visit = (node: any, parent?: any, index?: number) => {
      if (!node) return;
      if (node.type === "text" && typeof node.value === "string" && parent && typeof index === "number") {
        const value = node.value;
        const lower = value.toLowerCase();
        let cursor = 0;
        const children = [];

        while (cursor < value.length) {
          const found = lower.indexOf(needle, cursor);
          if (found < 0) {
            children.push({ type: "text", value: value.slice(cursor) });
            break;
          }
          if (found > cursor) {
            children.push({ type: "text", value: value.slice(cursor, found) });
          }
          children.push({
            type: "element",
            tagName: "mark",
            properties: { className: ["search-hit"] },
            children: [{ type: "text", value: value.slice(found, found + query.length) }],
          });
          cursor = found + query.length;
        }

        parent.children.splice(index, 1, ...children);
        return;
      }

      if (Array.isArray(node.children)) {
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          visit(node.children[i], node, i);
        }
      }
    };

    visit(tree);
  };
}

function findSearchMatches(markdown: string, query: string, headings: FlatHeading[]): SearchMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const lower = markdown.toLowerCase();
  const needle = trimmed.toLowerCase();
  const lineStarts = markdown.split(/\r?\n/).reduce<number[]>((starts, line) => {
    const previous = starts[starts.length - 1] ?? 0;
    starts.push(previous + line.length + 1);
    return starts;
  }, [0]);

  const headingRanges = headings.map((heading, index) => ({
    id: heading.id,
    start: lineStarts[heading.line] ?? 0,
    end: index + 1 < headings.length ? lineStarts[headings[index + 1].line] ?? markdown.length : markdown.length,
  }));

  const matches: SearchMatch[] = [];
  let cursor = 0;
  while (cursor < lower.length) {
    const index = lower.indexOf(needle, cursor);
    if (index < 0) break;
    const range = headingRanges.find((heading) => index >= heading.start && index < heading.end);
    matches.push({
      id: `match-${matches.length}`,
      index,
      end: index + needle.length,
      headingId: range?.id ?? null,
    });
    cursor = index + needle.length;
  }
  return matches;
}

function stripSvgDimensions(svg: string): string {
  return svg.replace(/<svg([^>]*)>/, (_, attrs: string) => {
    const cleaned = attrs.replace(/style="([^"]*)"/, (_, styleContent: string) => {
      const newStyle = styleContent.replace(/max-width\s*:[^;]*;?\s*/g, "").trim();
      return newStyle ? `style="${newStyle}"` : "";
    });
    return `<svg${cleaned}>`;
  });
}

function MermaidBlock({ code, darkMode }: { code: string; darkMode: boolean }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${crypto.randomUUID()}`;

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: darkMode ? "dark" : "default",
    });

    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (cancelled) return;
        setSvg(svg);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSvg("");
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [code, darkMode]);

  useEffect(() => {
    if (!overlayOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverlayOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [overlayOpen]);

  if (error) {
    return (
      <figure className="mermaid-error">
        <figcaption>Mermaid syntax error</figcaption>
        <pre>{error}</pre>
        <code>{code}</code>
      </figure>
    );
  }

  return (
    <>
      <div
        className={["mermaid-view", svg ? "mermaid-view--clickable" : ""].join(" ")}
        dangerouslySetInnerHTML={{ __html: svg }}
        onClick={() => { if (svg) setOverlayOpen(true); }}
        title={svg ? "クリックして拡大表示" : undefined}
      />
      {overlayOpen ? (
        <div className="mermaid-overlay" onClick={() => setOverlayOpen(false)}>
          <div
            className="mermaid-overlay-content"
            dangerouslySetInnerHTML={{ __html: stripSvgDimensions(svg) }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="mermaid-overlay-close"
            onClick={() => setOverlayOpen(false)}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}

function OutlineList({
  items,
  activeId,
  matchingHeadingIds,
  onSelect,
}: {
  items: OutlineItem[];
  activeId: string | null;
  matchingHeadingIds: Set<string>;
  onSelect: (id: string) => void;
}) {
  return (
    <ol className="outline-list">
      {items.map((item) => (
        <li key={item.id}>
          <button
            data-outline-id={item.id}
            className={[
              "outline-item",
              item.id === activeId ? "active" : "",
              matchingHeadingIds.has(item.id) ? "contains-match" : "",
            ].join(" ")}
            style={{ paddingLeft: `${(item.level - 1) * 14 + 10}px` }}
            onClick={() => onSelect(item.id)}
          >
            <span>{item.text}</span>
          </button>
          {item.children.length > 0 ? (
            <OutlineList
              items={item.children}
              activeId={activeId}
              matchingHeadingIds={matchingHeadingIds}
              onSelect={onSelect}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function FileTree({
  nodes,
  activeTabId,
  expandedPaths,
  level,
  onToggleDir,
  onOpenFile,
}: {
  nodes: FileNode[];
  activeTabId: string | null;
  expandedPaths: Set<string>;
  level: number;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <ul className="file-tree-list">
      {nodes.map((node) => {
        const normalizedPath = normalizePath(node.path);
        if (node.is_directory) {
          const expanded = expandedPaths.has(normalizedPath);
          return (
            <li key={normalizedPath}>
              <button
                type="button"
                className="tree-dir"
                style={{ paddingLeft: `${level * 12 + 8}px` }}
                onClick={() => onToggleDir(normalizedPath)}
              >
                <span className="tree-chevron">
                  {expanded ? <ChevronDown size={11} strokeWidth={2.5} /> : <ChevronRight size={11} strokeWidth={2.5} />}
                </span>
                <span>{node.name}</span>
              </button>
              {expanded ? (
                <FileTree
                  nodes={node.children}
                  activeTabId={activeTabId}
                  expandedPaths={expandedPaths}
                  level={level + 1}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </li>
          );
        }
        const isActive = activeTabId === normalizedPath;
        return (
          <li key={normalizedPath}>
            <button
              type="button"
              className={["tree-file", isActive ? "active" : ""].join(" ")}
              style={{ paddingLeft: `${level * 12 + 20}px` }}
              title={node.path}
              onClick={() => onOpenFile(node.path)}
            >
              <span>{node.name.replace(/\.(md|markdown|mdown|mkd)$/i, "")}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [status, setStatus] = useState("No file opened");
  const [dragActive, setDragActive] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [toolbarMode, setToolbarMode] = useState<ToolbarMode>(() =>
    localStorage.getItem(TOOLBAR_MODE_KEY) === "auto" ? "auto" : "always",
  );
  const [fontScale, setFontScale] = useState(() => {
    const saved = Number(localStorage.getItem("doctrail.fontScale"));
    return Number.isFinite(saved) && saved >= MIN_FONT_SCALE && saved <= MAX_FONT_SCALE ? saved : DEFAULT_FONT_SCALE;
  });
  const [darkMode, setDarkMode] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [directoryRoot, setDirectoryRoot] = useState<FileNode[] | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const previewRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const fileTabsRef = useRef<HTMLElement | null>(null);
  const headingRenderIndex = useRef(0);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [activeTabId, tabs]);
  const markdown = activeTab?.markdown ?? SAMPLE_MARKDOWN;
  const filePath = activeTab?.path ?? null;
  const headings = useMemo(() => extractHeadings(markdown), [markdown]);
  const baseDir = useMemo(() => (filePath ? dirname(filePath) : null), [filePath]);
  const searchMatches = useMemo(() => findSearchMatches(markdown, query, headings.flat), [markdown, query, headings.flat]);
  const matchingHeadingIds = useMemo(
    () => new Set(searchMatches.map((match) => match.headingId).filter(Boolean) as string[]),
    [searchMatches],
  );
  const searchPlugin = useMemo(() => createSearchPlugin(query), [query]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setDarkMode(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    localStorage.setItem("doctrail.fontScale", String(fontScale));
  }, [fontScale]);

  useEffect(() => {
    localStorage.setItem(TOOLBAR_MODE_KEY, toolbarMode);
    setToolbarVisible(toolbarMode === "always");
  }, [toolbarMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setFontScale((current) => Math.min(MAX_FONT_SCALE, current + FONT_SCALE_STEP));
      } else if (event.key === "-") {
        event.preventDefault();
        setFontScale((current) => Math.max(MIN_FONT_SCALE, current - FONT_SCALE_STEP));
      } else if (event.key === "0") {
        event.preventDefault();
        setFontScale(DEFAULT_FONT_SCALE);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (activeMatchIndex >= searchMatches.length) setActiveMatchIndex(0);
  }, [activeMatchIndex, searchMatches.length]);

  useEffect(() => {
    setActiveHeadingId(null);
    setActiveMatchIndex(0);
    previewRef.current?.scrollTo({ top: 0 });
  }, [activeTabId]);

  useEffect(() => {
    if (!previewRef.current) return;
    const preview = previewRef.current;

    let frame = 0;
    const updateActiveHeading = () => {
      frame = 0;
      const nodes = Array.from(preview.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id]"));
      if (nodes.length === 0) {
        setActiveHeadingId(null);
        return;
      }
      const previewTop = preview.getBoundingClientRect().top;
      const marker = 72;
      let active = nodes[0];

      for (const node of nodes) {
        const headingTop = node.getBoundingClientRect().top - previewTop;
        if (headingTop <= marker) {
          active = node;
        } else {
          break;
        }
      }

      setActiveHeadingId(active.id);
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveHeading);
    };

    updateActiveHeading();
    preview.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      preview.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [fontScale, markdown, query]);

  useEffect(() => {
    if (!activeHeadingId) return;
    const outline = outlineRef.current;
    const active = outline?.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(activeHeadingId)}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeHeadingId]);

  useEffect(() => {
    const active = previewRef.current?.querySelectorAll(".search-hit")[activeMatchIndex] as HTMLElement | undefined;
    previewRef.current?.querySelectorAll(".search-hit.current").forEach((node) => node.classList.remove("current"));
    if (active) {
      active.classList.add("current");
      active.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeMatchIndex, searchMatches.length, query]);

  const loadFiles = useCallback(async (paths: string[]) => {
    const markdownPaths = Array.from(new Set(paths.filter(isMarkdownPath)));
    if (markdownPaths.length === 0) {
      setStatus("Open a Markdown file (.md, .markdown, .mdown, .mkd)");
      return;
    }

    const loadedTabs: DocumentTab[] = [];
    for (const path of markdownPaths) {
      const text = await readTextFile(path);
      loadedTabs.push({
        id: normalizePath(path),
        path,
        name: basename(path),
        markdown: text,
      });
    }

    setTabs((current) => {
      const byId = new Map(current.map((tab) => [tab.id, tab]));
      for (const tab of loadedTabs) {
        byId.set(tab.id, tab);
      }
      return Array.from(byId.values());
    });
    setActiveTabId(loadedTabs[0].id);
    setStatus(loadedTabs[0].path);
    setActiveMatchIndex(0);
  }, []);

  const loadFile = useCallback(async (path: string) => {
    await loadFiles([path]);
  }, [loadFiles]);

  const loadDirectory = useCallback(async (path: string) => {
    try {
      const nodes = await invoke<FileNode[]>("scan_directory", { path });
      setDirectoryRoot(nodes);
      setExpandedPaths(new Set());
      setStatus(basename(path));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const toggleDir = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const selectTab = useCallback(
    (id: string) => {
      const tab = tabs.find((tab) => tab.id === id);
      setActiveTabId(id);
      if (tab) setStatus(tab.path);
    },
    [tabs],
  );

  const reloadActiveFile = useCallback(async () => {
    if (!activeTab) return;
    const text = await readTextFile(activeTab.path);
    setTabs((current) => current.map((tab) => (tab.id === activeTab.id ? { ...tab, markdown: text } : tab)));
    setStatus(activeTab.path);
    setActiveMatchIndex(0);
  }, [activeTab]);

  const closeTab = useCallback(
    (id: string) => {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;

      const next = tabs.filter((tab) => tab.id !== id);
      setTabs(next);
      if (activeTabId === id) {
        const fallback = next[Math.min(index, next.length - 1)] ?? null;
        setActiveTabId(fallback?.id ?? null);
        setStatus(fallback?.path ?? "No file opened");
      }
    },
    [activeTabId, tabs],
  );

  const loadDroppedPath = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        if (!isMarkdownPath(path)) {
          try {
            const nodes = await invoke<FileNode[]>("scan_directory", { path });
            setDirectoryRoot(nodes);
            setExpandedPaths(new Set());
            setStatus(basename(path));
            return;
          } catch {
            // not a directory, continue
          }
        }
      }
      const markdownPaths = paths.filter(isMarkdownPath);
      if (markdownPaths.length === 0) {
        setStatus("Drop a Markdown file or folder");
        return;
      }
      await loadFiles(markdownPaths);
    },
    [loadFiles],
  );

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | undefined;
    const handleDropEvent = async (event: { payload: DragDropEvent }) => {
      if (event.payload.type === "enter") {
        setDragActive(true);
        setStatus("Drop Markdown file to open");
        return;
      }

      if (event.payload.type === "over") {
        setDragActive(true);
        return;
      }

      setDragActive(false);
      if (event.payload.type === "drop") {
        await loadDroppedPath(event.payload.paths);
      }
    };

    getCurrentWebview()
      .onDragDropEvent(handleDropEvent)
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });

    return () => unlisten?.();
  }, [loadDroppedPath]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | undefined;

    const openPaths = async (files: string[], directory?: string | null) => {
      if (directory) {
        await loadDirectory(directory);
        return;
      }
      const markdownPaths = files.filter(isMarkdownPath);
      if (markdownPaths.length > 0) {
        await loadFiles(markdownPaths);
      }
    };

    invoke<{ files: string[]; directory: string | null }>("take_pending_open_paths")
      .then(({ files, directory }) => openPaths(files, directory))
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });

    listen<string[]>("open-files", (event) => {
      void loadDroppedPath(event.payload);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });

    return () => unlisten?.();
  }, [loadFiles, loadDirectory, loadDroppedPath]);

  const handleOpen = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
    });
    if (typeof selected === "string") {
      await loadFile(selected);
    } else if (Array.isArray(selected)) {
      await loadFiles(selected);
    }
  }, [loadFile, loadFiles]);

  const handleOpenFolder = useCallback(async () => {
    const selected = await open({ directory: true });
    if (typeof selected === "string") {
      await loadDirectory(selected);
    }
  }, [loadDirectory]);

  const handleReload = useCallback(async () => {
    await reloadActiveFile();
  }, [reloadActiveFile]);

  useEffect(() => {
    const handleReloadKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key !== "r" && event.key !== "R") return;
      event.preventDefault();
      void reloadActiveFile();
    };

    window.addEventListener("keydown", handleReloadKey);
    return () => window.removeEventListener("keydown", handleReloadKey);
  }, [reloadActiveFile]);

  useEffect(() => {
    const handleFindKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key !== "f" && event.key !== "F") return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    window.addEventListener("keydown", handleFindKey);
    return () => window.removeEventListener("keydown", handleFindKey);
  }, []);

  const jumpToHeading = useCallback((id: string) => {
    const preview = previewRef.current;
    const target = preview?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (target && preview) {
      const top = preview.scrollTop + target.getBoundingClientRect().top - preview.getBoundingClientRect().top - 22;
      preview.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    setActiveHeadingId(id);
  }, []);

  const moveMatch = useCallback(
    (direction: 1 | -1) => {
      if (searchMatches.length === 0) return;
      setActiveMatchIndex((current) => (current + direction + searchMatches.length) % searchMatches.length);
    },
    [searchMatches.length],
  );

  const changeFontScale = useCallback((delta: number) => {
    setFontScale((current) => Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, current + delta)));
  }, []);

  headingRenderIndex.current = 0;

  return (
    <div
      className={[
        "app",
        dragActive ? "drag-active" : "",
        toolbarMode === "auto" ? "toolbar-auto" : "toolbar-always",
        toolbarVisible ? "toolbar-visible" : "",
      ].join(" ")}
      onMouseMove={(event) => {
        if (toolbarMode !== "auto") return;
        const overFileTabs = fileTabsRef.current?.contains(event.target as Node) ?? false;
        setToolbarVisible(!overFileTabs && event.clientY <= 72);
      }}
    >
      {dragActive ? <div className="drop-overlay">Drop Markdown file to open</div> : null}
      {toolbarMode === "auto" ? (
        <div className="toolbar-hover-zone" onMouseEnter={() => setToolbarVisible(true)} aria-hidden="true" />
      ) : null}
      <header className="toolbar">
        <div className="window-title">DocTrail</div>
        <button type="button" className="icon-button" title="Open Markdown files" aria-label="Open Markdown files" onClick={handleOpen}>
          <FolderOpen size={16} strokeWidth={2} />
        </button>
        <button type="button" className="icon-button" title="Open folder" aria-label="Open folder" onClick={handleOpenFolder}>
          <FolderTree size={16} strokeWidth={2} />
        </button>
        <button type="button" className="icon-button" title="Reload active file" aria-label="Reload active file" onClick={handleReload} disabled={!filePath}>
          <RotateCw size={16} strokeWidth={2} />
        </button>
        <div className="toolbar-divider" />
        <div className="font-controls" aria-label="Preview font size">
          <button
            type="button"
            title="Decrease preview font size"
            aria-label="Decrease preview font size"
            onClick={() => changeFontScale(-FONT_SCALE_STEP)}
            disabled={fontScale <= MIN_FONT_SCALE}
          >
            <ZoomOut size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="font-scale"
            title="Reset preview font size"
            aria-label="Reset preview font size"
            onClick={() => setFontScale(DEFAULT_FONT_SCALE)}
          >
            {fontScale}%
          </button>
          <button
            type="button"
            title="Increase preview font size"
            aria-label="Increase preview font size"
            onClick={() => changeFontScale(FONT_SCALE_STEP)}
            disabled={fontScale >= MAX_FONT_SCALE}
          >
            <ZoomIn size={14} strokeWidth={2} />
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          title={toolbarMode === "always" ? "Show toolbar only near top" : "Always show toolbar"}
          aria-label={toolbarMode === "always" ? "Show toolbar only near top" : "Always show toolbar"}
          aria-pressed={toolbarMode === "always"}
          onClick={() => setToolbarMode((current) => (current === "always" ? "auto" : "always"))}
        >
          {toolbarMode === "always" ? <Pin size={16} strokeWidth={2} /> : <PinOff size={16} strokeWidth={2} />}
        </button>
        <div className="file-status" title={status}>
          {status}
        </div>
      </header>

      <main className={["workspace", directoryRoot ? "with-file-tree" : tabs.length > 1 ? "with-file-tabs" : ""].join(" ")}>
        {directoryRoot ? (
          <aside ref={fileTabsRef} className="file-tree" aria-label="Directory tree">
            <div className="file-tree-scroll">
              <FileTree
                nodes={directoryRoot}
                activeTabId={activeTabId}
                expandedPaths={expandedPaths}
                level={0}
                onToggleDir={toggleDir}
                onOpenFile={loadFile}
              />
            </div>
          </aside>
        ) : tabs.length > 1 ? (
          <aside ref={fileTabsRef} className="file-tabs" aria-label="Open files">
            <div className="file-tabs-list">
              {tabs.map((tab) => (
                <div key={tab.id} className={["file-tab-row", tab.id === activeTabId ? "active" : ""].join(" ")}>
                  <button type="button" className="file-tab" title={tab.path} onClick={() => selectTab(tab.id)}>
                    <span>{tab.name}</span>
                  </button>
                  <button type="button" className="file-tab-close" aria-label={`Close ${tab.name}`} onClick={() => closeTab(tab.id)}>
                    x
                  </button>
                </div>
              ))}
            </div>
          </aside>
        ) : null}
        <aside className="sidebar">
          <div className="search-panel">
            <input
              ref={searchInputRef}
              type="search"
              placeholder="Search in document"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  moveMatch(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <div className="search-count">
              {query.trim() ? `${searchMatches.length ? activeMatchIndex + 1 : 0} / ${searchMatches.length}` : "0 / 0"}
            </div>
          </div>

          <nav ref={outlineRef} className="outline" aria-label="Markdown outline">
            {headings.tree.length > 0 ? (
              <OutlineList
                items={headings.tree}
                activeId={activeHeadingId}
                matchingHeadingIds={matchingHeadingIds}
                onSelect={jumpToHeading}
              />
            ) : (
              <div className="empty-outline">No headings</div>
            )}
          </nav>
        </aside>

        <section
          ref={previewRef}
          className="preview-shell"
          style={{ "--preview-font-size": `${fontScale}%` } as CSSProperties}
        >
          <article className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[searchPlugin, rehypeHighlight]}
              components={{
                h1({ children }) {
                  const heading = headings.flat[headingRenderIndex.current++];
                  return <h1 id={heading?.id}>{children}</h1>;
                },
                h2({ children }) {
                  const heading = headings.flat[headingRenderIndex.current++];
                  return <h2 id={heading?.id}>{children}</h2>;
                },
                h3({ children }) {
                  const heading = headings.flat[headingRenderIndex.current++];
                  return <h3 id={heading?.id}>{children}</h3>;
                },
                h4({ children }) {
                  const heading = headings.flat[headingRenderIndex.current++];
                  return <h4 id={heading?.id}>{children}</h4>;
                },
                code({ className, children, ...props }) {
                  const language = /language-(\w+)/.exec(className ?? "")?.[1];
                  const code = String(children).replace(/\n$/, "");
                  // インラインコード（例: `graph.js`）を Mermaid と誤判定しないよう、
                  // 言語タグ付き or 複数行のフェンスドブロックのみ自動判定の対象にする。
                  const isBlock = language !== undefined || code.includes("\n");
                  if (isBlock && isMermaidCode(language, code)) {
                    return <MermaidBlock code={code} darkMode={darkMode} />;
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                img({ src, alt }) {
                  return <img src={resolveRelativePath(baseDir, src)} alt={alt ?? ""} loading="lazy" />;
                },
                a({ href, children }) {
                  return (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  );
                },
              }}
            >
              {markdown}
            </ReactMarkdown>
          </article>
        </section>
      </main>
    </div>
  );
}
