import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Columns2,
  FileCode,
  RefreshCcw,
  Rows3,
  Save,
} from "lucide-react";
import type * as Monaco from "monaco-editor";
import "@/lib/monaco";
import { readTextFile, writeTextFile } from "@/lib/filesystem";
import { getGitDiff } from "@/lib/git";
import type { PanelProps } from "@/lib/panelRegistry";
import type { GitDiffPayload } from "@/types/git";
import { cn } from "@/lib/utils";
import { useConfirmationStore } from "@/store/useConfirmationStore";
import { usePanelGuardStore, type PanelGuardReason } from "@/store/usePanelGuardStore";

type EditorStatus = "empty" | "loading" | "ready" | "saving" | "error";
type MonacoPanelView = "file" | "git-diff";

interface LoadedResource {
  path: string;
  size: number;
  modifiedMs: number;
}

interface MonacoFilePanelState {
  view?: "file";
  filePath?: string;
}

interface MonacoGitDiffPanelState {
  view: "git-diff";
  filePath: string;
  staged?: boolean;
  oldPath?: string;
}

type MonacoPanelState = MonacoFilePanelState | MonacoGitDiffPanelState;
type DiffLayoutOverride = boolean | null;
interface DiffLayoutOverrideState {
  key: string;
  value: DiffLayoutOverride;
}

const DIFF_INLINE_BREAKPOINT = 1000;

export function MonacoEditorPanel({ panel, rootDirectory, isActive }: PanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const dirtyRef = useRef(false);
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const loadCounterRef = useRef(0);
  const savedContentRef = useRef("");
  const confirm = useConfirmationStore((state) => state.confirm);
  const { registerGuard, unregisterGuard } = usePanelGuardStore();

  const panelState = (panel.state ?? {}) as MonacoPanelState;
  const view: MonacoPanelView = panelState.view === "git-diff" ? "git-diff" : "file";
  const filePath = typeof panelState.filePath === "string" ? panelState.filePath : "";
  const diffPanelState = view === "git-diff" ? (panelState as MonacoGitDiffPanelState) : null;
  const diffStaged = diffPanelState ? Boolean(diffPanelState.staged) : false;
  const fileName = useMemo(() => basename(filePath), [filePath]);
  const [status, setStatus] = useState<EditorStatus>(filePath ? "loading" : "empty");
  const [value, setValue] = useState("");
  const [loadedResource, setLoadedResource] = useState<LoadedResource | null>(null);
  const [diffResource, setDiffResource] = useState<GitDiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [diffLayoutOverrideState, setDiffLayoutOverrideState] = useState<DiffLayoutOverrideState>({
    key: "",
    value: null,
  });
  const [containerWidth, setContainerWidth] = useState(0);
  const [hasDiffChanges, setHasDiffChanges] = useState(false);

  const diffLayoutKey = `${view}:${filePath}:${diffStaged ? "staged" : "unstaged"}`;
  const diffLayoutOverride =
    diffLayoutOverrideState.key === diffLayoutKey ? diffLayoutOverrideState.value : null;
  const effectiveFilePath = diffResource?.modifiedPath ?? filePath;
  const language = useMemo(() => languageFromPath(effectiveFilePath), [effectiveFilePath]);
  const adaptiveSideBySide = containerWidth >= DIFF_INLINE_BREAKPOINT;
  const renderSideBySide = diffLayoutOverride ?? adaptiveSideBySide;

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth((current) => (current === width ? current : width));
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const confirmDiscard = useCallback(
    (reason: PanelGuardReason) => {
      if (!dirtyRef.current) return Promise.resolve(true);
      return confirm({
        title: "Discard unsaved changes?",
        description: guardDescription(reason, fileName),
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
      });
    },
    [confirm, fileName],
  );

  useEffect(() => {
    registerGuard(panel.id, confirmDiscard);
    return () => unregisterGuard(panel.id);
  }, [confirmDiscard, panel.id, registerGuard, unregisterGuard]);

  const syncDiffState = useCallback((editor: Monaco.editor.IStandaloneDiffEditor | null) => {
    const lineChanges = editor?.getLineChanges() ?? null;
    setHasDiffChanges(Boolean(lineChanges && lineChanges.length > 0));
  }, []);

  const loadResource = useCallback(async () => {
    if (!filePath) {
      setStatus("empty");
      setValue("");
      setLoadedResource(null);
      setDiffResource(null);
      setError(null);
      setDirty(false);
      setHasDiffChanges(false);
      savedContentRef.current = "";
      return;
    }

    const loadId = loadCounterRef.current + 1;
    loadCounterRef.current = loadId;
    setStatus("loading");
    setError(null);
    setHasDiffChanges(false);

    try {
      if (view === "git-diff") {
        const diff = await getGitDiff(rootDirectory, filePath, diffStaged);
        if (loadCounterRef.current !== loadId) return;
        savedContentRef.current = diff.modifiedContent;
        setDiffResource(diff);
        setValue("");
        setLoadedResource({
          path: diff.modifiedPath,
          size: diff.modifiedContent.length,
          modifiedMs: 0,
        });
        setDirty(false);
        setStatus("ready");
        queueMicrotask(() => {
          syncDiffState(diffEditorRef.current);
          diffEditorRef.current?.revealFirstDiff();
        });
        return;
      }

      const file = await readTextFile(rootDirectory, filePath);
      if (loadCounterRef.current !== loadId) return;
      savedContentRef.current = file.content;
      setValue(file.content);
      setLoadedResource({ path: file.path, size: file.size, modifiedMs: file.modifiedMs });
      setDiffResource(null);
      setDirty(false);
      setStatus("ready");
    } catch (err) {
      if (loadCounterRef.current !== loadId) return;
      setError(formatError(err));
      setLoadedResource(null);
      setDiffResource(null);
      setDirty(false);
      setHasDiffChanges(false);
      setStatus("error");
    }
  }, [diffStaged, filePath, rootDirectory, syncDiffState, view]);

  useEffect(() => {
    queueMicrotask(() => void loadResource());
  }, [loadResource]);

  const saveFile = useCallback(async () => {
    if (view === "git-diff" || !filePath || !loadedResource || status === "saving") return;

    setStatus("saving");
    setError(null);
    try {
      const file = await writeTextFile(
        rootDirectory,
        loadedResource.path,
        value,
        loadedResource.modifiedMs,
      );
      savedContentRef.current = file.content;
      setValue(file.content);
      setLoadedResource({ path: file.path, size: file.size, modifiedMs: file.modifiedMs });
      setDirty(false);
      setStatus("ready");
    } catch (err) {
      setError(formatError(err));
      setStatus("error");
    }
  }, [filePath, loadedResource, rootDirectory, status, value, view]);

  useEffect(() => {
    saveRef.current = saveFile;
  }, [saveFile]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
  };

  const handleDiffMount = useCallback(
    (editor: Monaco.editor.IStandaloneDiffEditor, monaco: typeof Monaco) => {
      diffEditorRef.current = editor;
      const modifiedEditor = editor.getModifiedEditor();
      modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveRef.current();
      });
      editor.onDidUpdateDiff(() => syncDiffState(editor));
      syncDiffState(editor);
      editor.revealFirstDiff();
    },
    [syncDiffState],
  );

  useEffect(() => {
    if (!isActive) return;
    window.requestAnimationFrame(() => {
      editorRef.current?.layout();
      diffEditorRef.current?.layout();
    });
  }, [isActive, renderSideBySide]);

  useEffect(() => {
    if (view !== "git-diff") return;
    diffEditorRef.current?.updateOptions({
      renderSideBySide,
      useInlineViewWhenSpaceIsLimited: diffLayoutOverride === null,
      renderSideBySideInlineBreakpoint: DIFF_INLINE_BREAKPOINT,
    });
  }, [diffLayoutOverride, renderSideBySide, view]);

  const handleReload = async () => {
    const confirmed = await confirmDiscard("reload");
    if (confirmed) void loadResource();
  };

  const handleToggleDiffLayout = useCallback(() => {
    setDiffLayoutOverrideState((current) => {
      const currentOverride = current.key === diffLayoutKey ? current.value : null;
      return {
        key: diffLayoutKey,
        value: !(currentOverride ?? adaptiveSideBySide),
      };
    });
  }, [adaptiveSideBySide, diffLayoutKey]);

  const handleGoToDiff = useCallback((target: "next" | "previous") => {
    diffEditorRef.current?.goToDiff(target);
  }, []);

  if (!filePath) {
    return (
      <div className="flex h-full flex-col bg-zinc-950 text-zinc-400">
        <EditorToolbar
          fileName="No file selected"
          filePath=""
          language="text"
          dirty={false}
          disabled
          status={status}
          view="file"
          onSave={saveFile}
          onReload={handleReload}
        />
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          Select a file from the explorer.
        </div>
      </div>
    );
  }

  const displayPath =
    view === "git-diff"
      ? diffResource
        ? `${diffResource.originalPath} -> ${diffResource.modifiedPath}`
        : filePath
      : (loadedResource?.path ?? filePath);

  return (
    <div ref={containerRef} className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <EditorToolbar
        fileName={
          view === "git-diff" ? `${fileName}${diffStaged ? " (staged diff)" : " (diff)"}` : fileName
        }
        filePath={displayPath}
        language={language}
        dirty={dirty}
        disabled={status === "loading" || status === "saving" || !loadedResource}
        status={status}
        view={view}
        diffModeLabel={
          view === "git-diff"
            ? renderSideBySide
              ? diffLayoutOverride === null
                ? "Split auto"
                : "Split"
              : diffLayoutOverride === null
                ? "Inline auto"
                : "Inline"
            : null
        }
        canNavigateDiffs={hasDiffChanges}
        renderSideBySide={renderSideBySide}
        onGoToNextDiff={() => handleGoToDiff("next")}
        onGoToPreviousDiff={() => handleGoToDiff("previous")}
        onToggleDiffLayout={handleToggleDiffLayout}
        onSave={saveFile}
        onReload={handleReload}
      />
      {error && (
        <div className="flex items-center gap-2 border-b border-red-950/70 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button
            type="button"
            onClick={() => void loadResource()}
            className="rounded border border-red-800 px-2 py-1 text-red-100 transition-colors hover:bg-red-900/50"
          >
            Retry
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {view === "git-diff" ? (
          <DiffEditor
            theme="vs-dark"
            language={language}
            original={diffResource?.originalContent ?? ""}
            modified={diffResource?.modifiedContent ?? ""}
            originalModelPath={diffModelPath(
              diffResource?.originalPath ?? filePath,
              diffStaged,
              "original",
            )}
            modifiedModelPath={diffModelPath(
              diffResource?.modifiedPath ?? filePath,
              diffStaged,
              "modified",
            )}
            loading={<div className="p-3 text-xs text-zinc-500">Loading diff...</div>}
            onMount={handleDiffMount}
            options={{
              automaticLayout: true,
              fontFamily: '"IBM Plex Mono", Menlo, Monaco, "Courier New", monospace',
              fontSize: 13,
              minimap: { enabled: false },
              readOnly: true,
              originalEditable: false,
              renderSideBySide,
              useInlineViewWhenSpaceIsLimited: diffLayoutOverride === null,
              renderSideBySideInlineBreakpoint: DIFF_INLINE_BREAKPOINT,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderIndicators: true,
              diffCodeLens: true,
            }}
          />
        ) : (
          <Editor
            theme="vs-dark"
            path={filePath}
            language={language}
            value={value}
            loading={<div className="p-3 text-xs text-zinc-500">Loading...</div>}
            onMount={handleEditorMount}
            onChange={(nextValue) => {
              const next = nextValue ?? "";
              setValue(next);
              setDirty(next !== savedContentRef.current);
            }}
            options={{
              automaticLayout: true,
              fontFamily: '"IBM Plex Mono", Menlo, Monaco, "Courier New", monospace',
              fontSize: 13,
              minimap: { enabled: false },
              readOnly: false,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              tabSize: 2,
            }}
          />
        )}
      </div>
    </div>
  );
}

interface EditorToolbarProps {
  fileName: string;
  filePath: string;
  language: string;
  dirty: boolean;
  disabled: boolean;
  status: EditorStatus;
  view: MonacoPanelView;
  diffModeLabel?: string | null;
  canNavigateDiffs?: boolean;
  renderSideBySide?: boolean;
  onGoToNextDiff?: () => void;
  onGoToPreviousDiff?: () => void;
  onToggleDiffLayout?: () => void;
  onSave: () => Promise<void>;
  onReload: () => void;
}

function EditorToolbar({
  fileName,
  filePath,
  language,
  dirty,
  disabled,
  status,
  view,
  diffModeLabel,
  canNavigateDiffs = false,
  renderSideBySide = true,
  onGoToNextDiff,
  onGoToPreviousDiff,
  onToggleDiffLayout,
  onSave,
  onReload,
}: EditorToolbarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3">
      <FileCode className="h-4 w-4 shrink-0 text-zinc-500" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-zinc-100">{fileName}</span>
          {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
        </div>
        {filePath && <div className="truncate text-[11px] text-zinc-500">{filePath}</div>}
      </div>
      {view === "git-diff" && (
        <>
          {diffModeLabel && (
            <span className="hidden shrink-0 rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] uppercase text-zinc-500 sm:inline">
              {diffModeLabel}
            </span>
          )}
          <ToolbarButton
            title="Previous change"
            onClick={onGoToPreviousDiff}
            disabled={!canNavigateDiffs}
          >
            <ArrowUp className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton title="Next change" onClick={onGoToNextDiff} disabled={!canNavigateDiffs}>
            <ArrowDown className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title={renderSideBySide ? "Switch to inline diff" : "Switch to split diff"}
            onClick={onToggleDiffLayout}
            disabled={disabled}
          >
            {renderSideBySide ? <Rows3 className="h-4 w-4" /> : <Columns2 className="h-4 w-4" />}
          </ToolbarButton>
        </>
      )}
      <span className="hidden shrink-0 rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] uppercase text-zinc-500 sm:inline">
        {language}
      </span>
      <ToolbarButton title="Reload" onClick={onReload} disabled={disabled && status !== "error"}>
        <RefreshCcw className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        title={view === "git-diff" ? "Diff view is read only" : "Save"}
        onClick={() => void onSave()}
        disabled={view === "git-diff" || disabled || !dirty}
      >
        <Save className="h-4 w-4" />
      </ToolbarButton>
    </div>
  );
}

interface ToolbarButtonProps {
  title: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}

function ToolbarButton({ title, disabled = false, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

function diffModelPath(path: string, staged: boolean, side: "original" | "modified"): string {
  const suffix = staged ? "staged" : "working";
  return `git-diff:${suffix}:${side}:${path}`;
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "Untitled";
}

function languageFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    css: "css",
    html: "html",
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    xml: "xml",
    rs: "rust",
    c: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    h: "c",
    hpp: "cpp",
    hxx: "cpp",
    cs: "csharp",
    java: "java",
    kt: "kotlin",
    go: "go",
    swift: "swift",
    py: "python",
    rb: "ruby",
    pl: "perl",
    lua: "lua",
    r: "r",
    ex: "elixir",
    exs: "elixir",
    erl: "shell",
    hs: "haskell",
    clj: "clojure",
    scm: "scheme",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    fish: "shell",
    ps1: "powershell",
    bat: "batch",
    cmd: "batch",
    md: "markdown",
    mdx: "markdown",
    rst: "restructuredtext",
    tex: "latex",
    sql: "sql",
    php: "php",
    scala: "scala",
    groovy: "groovy",
    dart: "dart",
    graphql: "graphql",
    vim: "vim",
    ini: "ini",
    diff: "diff",
  };
  return extension ? (languages[extension] ?? "plaintext") : "plaintext";
}

function guardDescription(reason: PanelGuardReason, fileName: string): string {
  const target = fileName || "this file";
  if (reason === "replace-file") {
    return `${target} has unsaved changes. Opening another file will discard them.`;
  }
  if (reason === "change-type") {
    return `${target} has unsaved changes. Changing this panel will discard them.`;
  }
  if (reason === "reload") {
    return `${target} has unsaved changes. Reloading will discard them.`;
  }
  return `${target} has unsaved changes. Closing this panel will discard them.`;
}

function formatError(err: unknown): string {
  return typeof err === "string" ? err : String(err);
}
