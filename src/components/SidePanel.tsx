import { lazy, Suspense, useState, useCallback, useEffect, useRef } from "react";
import { Files, GitBranch, ChevronDown, ChevronRight, Github } from "lucide-react";
import { FileExplorer } from "./FileExplorer";
import { cn } from "@/lib/utils";
import { setWatchedRoot, stopWatchingRoot } from "@/lib/filesystem";
import { useActiveTabRootDirectory } from "@/hooks/useActiveSessionTabState";
import { useGitPanelHeaderStore } from "@/store/useGitPanelHeaderStore";

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 240;
const DEFAULT_EXPLORER_HEIGHT = 300;
const MIN_SECTION_HEIGHT = 60;
const LazyGitPanel = lazy(() =>
  import("./GitPanel").then((module) => ({ default: module.GitPanel })),
);

const clampSidePanelWidth = (nextWidth: number) =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, nextWidth));

const SectionHeader = ({
  icon: Icon,
  label,
  collapsed,
  onToggle,
  actions,
  iconClassName,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  iconClassName?: string;
}) => (
  <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs font-medium uppercase tracking-wider text-zinc-400 transition-colors hover:bg-zinc-800">
    <button
      onClick={onToggle}
      className="flex min-w-0 flex-1 select-none items-center gap-1.5 text-left"
    >
      {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      <Icon className={iconClassName ?? "h-3.5 w-3.5"} />
      <span className="truncate">{label}</span>
    </button>
    {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
  </div>
);

export const SidePanel = () => {
  const rootDirectory = useActiveTabRootDirectory();
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [explorerHeight, setExplorerHeight] = useState(DEFAULT_EXPLORER_HEIGHT);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [sourceControlCollapsed, setSourceControlCollapsed] = useState(true);
  const [gitPanelMounted, setGitPanelMounted] = useState(false);
  const gitPanelHeaderVisible = useGitPanelHeaderStore((state) => state.visible);
  const gitPanelHeaderUsername = useGitPanelHeaderStore((state) => state.username);
  const gitPanelHeaderTone = useGitPanelHeaderStore((state) => state.tone);
  const gitPanelHeaderRefreshing = useGitPanelHeaderStore((state) => state.isRefreshing);
  const gitPanelHeaderRefresh = useGitPanelHeaderStore((state) => state.onRefresh);
  const isDraggingWidth = useRef(false);
  const isDraggingHeight = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const widthHandleRef = useRef<HTMLDivElement>(null);

  const handleWidthMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingWidth.current = true;
      const startX = e.clientX;
      let currentWidth = width;
      const widthHandle = widthHandleRef.current;
      let pointerLockRequested = false;
      let pointerLockActive = false;

      const stopDragging = () => {
        isDraggingWidth.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("pointerlockchange", handlePointerLockChange);
        document.removeEventListener("pointerlockerror", handlePointerLockError);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        if (document.pointerLockElement === widthHandle) {
          document.exitPointerLock();
        }
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingWidth.current) return;

        if (pointerLockActive) {
          currentWidth = clampSidePanelWidth(currentWidth + moveEvent.movementX);
          setWidth(currentWidth);
          return;
        }

        currentWidth = clampSidePanelWidth(width + moveEvent.clientX - startX);
        setWidth(currentWidth);
      };

      const handleMouseUp = () => {
        stopDragging();
      };

      const handlePointerLockChange = () => {
        pointerLockActive = document.pointerLockElement === widthHandle;
        if (pointerLockRequested && !pointerLockActive && isDraggingWidth.current) {
          stopDragging();
        }
      };

      const handlePointerLockError = () => {
        pointerLockRequested = false;
        pointerLockActive = false;
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.addEventListener("pointerlockchange", handlePointerLockChange);
      document.addEventListener("pointerlockerror", handlePointerLockError);

      if (widthHandle?.requestPointerLock) {
        pointerLockRequested = true;

        try {
          const lockResult = widthHandle.requestPointerLock();
          if (lockResult instanceof Promise) {
            lockResult.catch(() => {
              pointerLockRequested = false;
              pointerLockActive = false;
            });
          }
        } catch {
          pointerLockRequested = false;
          pointerLockActive = false;
        }
      }
    },
    [width],
  );

  const handleHeightMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingHeight.current = true;
      const startY = e.clientY;
      const startHeight = explorerHeight;
      const panelHeight = panelRef.current?.clientHeight ?? 0;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingHeight.current) return;
        const delta = moveEvent.clientY - startY;
        const newHeight = Math.min(
          panelHeight - MIN_SECTION_HEIGHT,
          Math.max(MIN_SECTION_HEIGHT, startHeight + delta),
        );
        setExplorerHeight(newHeight);
      };

      const handleMouseUp = () => {
        isDraggingHeight.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [explorerHeight],
  );

  const bothExpanded = !explorerCollapsed && !sourceControlCollapsed;

  useEffect(() => {
    let cancelled = false;

    const setupWatcher = async () => {
      if (!rootDirectory) {
        await stopWatchingRoot().catch(() => {});
        return;
      }

      await setWatchedRoot(rootDirectory).catch((err) => {
        if (!cancelled) {
          console.error("Failed to set watched root:", err);
        }
      });
    };

    void setupWatcher();

    return () => {
      cancelled = true;
      void stopWatchingRoot().catch(() => {});
    };
  }, [rootDirectory]);

  return (
    <div
      ref={panelRef}
      className="relative flex h-full min-h-0 shrink-0 border-r border-zinc-800 bg-zinc-950"
      style={{ width }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Explorer section */}
        <div
          className={`flex flex-col overflow-hidden ${
            explorerCollapsed ? "" : bothExpanded ? "min-h-0 shrink-0" : "min-h-0 flex-1"
          }`}
          style={!explorerCollapsed && bothExpanded ? { height: explorerHeight } : undefined}
        >
          <SectionHeader
            icon={Files}
            label="Explorer"
            collapsed={explorerCollapsed}
            onToggle={() => setExplorerCollapsed(!explorerCollapsed)}
          />
          <div
            className={`overflow-hidden transition-all duration-200 ${
              explorerCollapsed ? "h-0" : "flex min-h-0 flex-1 flex-col"
            }`}
          >
            <div className="flex min-h-0 flex-1 flex-col text-xs text-zinc-500">
              <FileExplorer />
            </div>
          </div>
        </div>

        {/* Horizontal resize handle between sections */}
        {bothExpanded && (
          <div
            onMouseDown={handleHeightMouseDown}
            className="group z-10 -my-1 flex h-2 shrink-0 cursor-row-resize items-center justify-center"
          >
            <div className="h-px w-full bg-zinc-700 transition-colors group-hover:bg-zinc-400 group-active:bg-zinc-300" />
          </div>
        )}

        {/* Source Control section */}
        <div
          className={`flex min-h-0 flex-col overflow-hidden ${
            sourceControlCollapsed ? "" : "flex-1"
          }`}
        >
          <SectionHeader
            icon={GitBranch}
            label="Source Control"
            collapsed={sourceControlCollapsed}
            onToggle={() =>
              setSourceControlCollapsed((current) => {
                const next = !current;
                if (!next) {
                  setGitPanelMounted(true);
                }
                return next;
              })
            }
            iconClassName="h-4 w-4"
            actions={
              gitPanelHeaderVisible ? (
                <>
                  {gitPanelHeaderUsername ? (
                    <span className="hidden max-w-[110px] truncate text-[11px] normal-case tracking-normal text-zinc-500 sm:inline">
                      {gitPanelHeaderUsername}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      gitPanelHeaderRefresh?.();
                    }}
                    disabled={!gitPanelHeaderRefresh}
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      gitPanelHeaderTone === "success"
                        ? "border-emerald-900/70 bg-emerald-950/20 text-emerald-300 hover:bg-emerald-950/35"
                        : gitPanelHeaderTone === "danger"
                          ? "border-red-900/70 bg-red-950/20 text-red-300 hover:bg-red-950/35"
                          : gitPanelHeaderTone === "warning"
                            ? "border-amber-900/70 bg-amber-950/20 text-amber-300 hover:bg-amber-950/35"
                            : "border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
                    )}
                    title="Refresh Git status"
                  >
                    <Github
                      className={cn("h-3.5 w-3.5", gitPanelHeaderRefreshing && "animate-pulse")}
                    />
                  </button>
                </>
              ) : undefined
            }
          />
          <div
            className={`overflow-hidden transition-all duration-200 ${
              sourceControlCollapsed ? "h-0" : "min-h-0 flex-1"
            }`}
          >
            <div className="flex h-full min-h-0 flex-col">
              {gitPanelMounted ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-xs text-zinc-500">
                      Loading Source Control...
                    </div>
                  }
                >
                  <LazyGitPanel />
                </Suspense>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Vertical resize handle (width) */}
      <div
        ref={widthHandleRef}
        onMouseDown={handleWidthMouseDown}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-zinc-600 active:bg-zinc-500"
      />
    </div>
  );
};
