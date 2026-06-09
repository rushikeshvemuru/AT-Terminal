import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import {
  useActiveSessionId,
  useActiveTabId,
  useActiveTabRootDirectory,
} from "@/hooks/useActiveSessionTabState";
import { invalidateDirectories } from "@/hooks/useDirectoryListing";
import {
  useFlattenedFileTree,
  type FileTreeRow as FileTreeRowModel,
} from "@/hooks/useFlattenedFileTree";
import { FileExplorerHeader } from "@/components/FileExplorerHeader";
import { FileTreeRow } from "@/components/FileTreeRow";
import { createDirectory, createFile, importExternalPaths, renamePath } from "@/lib/filesystem";
import { MONACO_PANEL_TYPE } from "@/lib/panelRegistry";
import { prepareMonacoPanelsForPathRemoval } from "@/lib/monacoMutationGuards";
import { useConfirmationStore } from "@/store/useConfirmationStore";
import { usePanelGuardStore } from "@/store/usePanelGuardStore";
import { useFileExplorerStore } from "@/store/useFileExplorerStore";
import { useTabStore } from "@/store/useTabStore";
import { copyPathsToClipboard, deletePaths, movePaths } from "@/lib/bulkOperations";
import type { FileChangeBatchEvent, ImportExternalPathsResult } from "@/types/filesystem";
import { FolderOpen } from "lucide-react";

const FILE_TREE_ROW_HEIGHT = 24;
const EMPTY_PATHS: string[] = [];
const EMPTY_PATH_SET = new Set<string>();

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "Untitled";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function getParentPath(path: string, fallback: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : normalizePath(fallback);
}

function isDescendantPath(parentPath: string, targetPath: string): boolean {
  const parent = normalizePath(parentPath).replace(/\/+$/, "");
  const target = normalizePath(targetPath).replace(/\/+$/, "");
  return target === parent || target.startsWith(`${parent}/`);
}

function pruneNestedSelections(paths: string[], directoryPaths: Set<string>): string[] {
  const normalizedPaths = Array.from(new Set(paths.map((path) => normalizePath(path))));
  return normalizedPaths.filter((path) => {
    return !normalizedPaths.some((candidate) => {
      if (candidate === path) return false;
      if (!directoryPaths.has(candidate)) return false;
      return isDescendantPath(candidate, path);
    });
  });
}

function remapPath(path: string, movedMap: Map<string, string>): string {
  for (const [oldPath, movedPath] of movedMap.entries()) {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedMovedPath = normalizePath(movedPath);
    const normalizedPath = normalizePath(path);

    if (normalizedPath === normalizedOldPath) {
      return movedPath;
    }
    if (normalizedPath.startsWith(`${normalizedOldPath}/`)) {
      return normalizedPath.replace(normalizedOldPath, normalizedMovedPath);
    }
  }

  return path;
}

function remapPathSet(paths: Set<string>, movedMap: Map<string, string>): Set<string> {
  return new Set(Array.from(paths).map((path) => remapPath(path, movedMap)));
}

function pathSetEquals(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

function getSinglePathSelection(path: string, current: Set<string>): Set<string> {
  return current.size === 1 && current.has(path) ? current : new Set([path]);
}

function getRangeSelection(
  visibleRowOrder: string[],
  start: number,
  end: number,
  current: Set<string>,
): Set<string> {
  const nextPaths = visibleRowOrder.slice(start, end + 1);
  if (current.size === nextPaths.length && nextPaths.every((path) => current.has(path))) {
    return current;
  }
  return new Set(nextPaths);
}

function getActiveTabFromStore(sessionId: string, tabId: string) {
  return (
    useTabStore.getState().sessionStates[sessionId]?.tabs.find((tab) => tab.id === tabId) ?? null
  );
}

function resolveDropTarget(
  hovered: HTMLElement | null,
  rootDirectory: string | null,
): { dragOverPath: string | null; dropTargetDir: string | null } {
  if (!hovered || !rootDirectory) {
    return { dragOverPath: null, dropTargetDir: null };
  }

  const rowElement = hovered.closest("[data-file-row-path]") as HTMLElement | null;
  if (rowElement) {
    const isDirectory = rowElement.dataset.fileRowIsDirectory === "1";
    if (!isDirectory) {
      return { dragOverPath: null, dropTargetDir: null };
    }

    return {
      dragOverPath: rowElement.dataset.fileRowPath ?? null,
      dropTargetDir: rowElement.dataset.dropDir ?? null,
    };
  }

  if (hovered.closest("[data-drop-root]")) {
    return { dragOverPath: null, dropTargetDir: rootDirectory };
  }

  return { dragOverPath: null, dropTargetDir: null };
}

const VirtualListOuter = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function VirtualListOuter(props, ref) {
    return <div {...props} ref={ref} data-drop-root="1" />;
  },
);

interface VirtualFileTreeRowData {
  rows: FileTreeRowModel[];
  rootDirectory: string;
  searchFilter: string;
  renamingPath: string | null;
  focusedPath: string | null;
  selectedPaths: Set<string>;
  directoryPaths: Set<string>;
  dragOverPath: string | null;
  dropTargetDir: string | null;
  onSelectPath: (path: string, event: React.MouseEvent) => void;
  onContextSelectPath: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onPreviewFile: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
  onCreateSubmit: (parentPath: string, name: string, type: "file" | "directory") => void;
  onCancelCreate: () => void;
  onRowPointerDown: (path: string, event: React.PointerEvent<HTMLDivElement>) => void;
  onRowFocus: (path: string) => void;
  onRowKeyDown: (path: string, event: React.KeyboardEvent<HTMLDivElement>) => void;
  registerRowElement: (path: string, element: HTMLDivElement | null) => void;
  onBulkDelete: (paths: string[], dirs: Set<string>) => Promise<void>;
  onBulkCopyPaths: (paths: string[]) => Promise<void>;
}

function VirtualFileTreeRow({
  index,
  style,
  data,
}: ListChildComponentProps<VirtualFileTreeRowData>) {
  const row = data.rows[index];
  if (row.kind !== "entry") {
    return (
      <FileTreeRow
        row={row}
        style={style}
        rootDirectory={data.rootDirectory}
        searchFilter={data.searchFilter}
        isSelected={false}
        isFocused={false}
        isDragOver={false}
        isRenaming={false}
        tabIndex={-1}
        selectedPaths={data.selectedPaths}
        directoryPaths={data.directoryPaths}
        onSelectPath={data.onSelectPath}
        onContextSelectPath={data.onContextSelectPath}
        onToggleDirectory={data.onToggleDirectory}
        onPreviewFile={data.onPreviewFile}
        onOpenFile={data.onOpenFile}
        onRenameSubmit={data.onRenameSubmit}
        onCancelRename={data.onCancelRename}
        onCreateSubmit={data.onCreateSubmit}
        onCancelCreate={data.onCancelCreate}
        onRowPointerDown={data.onRowPointerDown}
        onRowFocus={data.onRowFocus}
        onRowKeyDown={data.onRowKeyDown}
        registerRowElement={data.registerRowElement}
        onBulkDelete={data.onBulkDelete}
        onBulkCopyPaths={data.onBulkCopyPaths}
      />
    );
  }

  return (
    <FileTreeRow
      row={row}
      style={style}
      rootDirectory={data.rootDirectory}
      searchFilter={data.searchFilter}
      isSelected={data.selectedPaths.has(row.entry.path)}
      isFocused={data.focusedPath === row.entry.path}
      isDragOver={data.dragOverPath === row.entry.path && data.dropTargetDir === row.entry.path}
      isRenaming={data.renamingPath === row.entry.path}
      tabIndex={data.focusedPath === row.entry.path ? 0 : -1}
      selectedPaths={data.selectedPaths}
      directoryPaths={data.directoryPaths}
      onSelectPath={data.onSelectPath}
      onContextSelectPath={data.onContextSelectPath}
      onToggleDirectory={data.onToggleDirectory}
      onPreviewFile={data.onPreviewFile}
      onOpenFile={data.onOpenFile}
      onRenameSubmit={data.onRenameSubmit}
      onCancelRename={data.onCancelRename}
      onCreateSubmit={data.onCreateSubmit}
      onCancelCreate={data.onCancelCreate}
      onRowPointerDown={data.onRowPointerDown}
      onRowFocus={data.onRowFocus}
      onRowKeyDown={data.onRowKeyDown}
      registerRowElement={data.registerRowElement}
      onBulkDelete={data.onBulkDelete}
      onBulkCopyPaths={data.onBulkCopyPaths}
    />
  );
}

export function FileExplorer() {
  const activeSessionId = useActiveSessionId();
  const activeTabId = useActiveTabId();
  const rootDirectory = useActiveTabRootDirectory();
  const addPanel = useTabStore((state) => state.addPanel);
  const setActivePanel = useTabStore((state) => state.setActivePanel);
  const updatePanelState = useTabStore((state) => state.updatePanelState);
  const updatePanel = useTabStore((state) => state.updatePanel);
  const setExplorerVisibleRows = useTabStore((state) => state.setExplorerVisibleRows);
  const toggleExplorerExpandedPath = useTabStore((state) => state.toggleExplorerExpandedPath);
  const setExplorerExpandedPaths = useTabStore((state) => state.setExplorerExpandedPaths);
  const clearExplorerExpandedPaths = useTabStore((state) => state.clearExplorerExpandedPaths);
  const setExplorerSelectedPaths = useTabStore((state) => state.setExplorerSelectedPaths);
  const toggleExplorerPathSelection = useTabStore((state) => state.toggleExplorerPathSelection);
  const setExplorerFocusedPath = useTabStore((state) => state.setExplorerFocusedPath);
  const clearExplorerFocusedPath = useTabStore((state) => state.clearExplorerFocusedPath);
  const setExplorerLastSelectedPath = useTabStore((state) => state.setExplorerLastSelectedPath);
  const clearExplorerSelection = useTabStore((state) => state.clearExplorerSelection);
  const setExplorerDragState = useTabStore((state) => state.setExplorerDragState);
  const resetExplorerDragState = useTabStore((state) => state.resetExplorerDragState);
  const confirm = useConfirmationStore((state) => state.confirm);
  const confirmPanelAction = usePanelGuardStore((s) => s.confirmPanelAction);
  const explorerUiState = useTabStore((s) =>
    activeSessionId && activeTabId
      ? s.explorerStateBySessionTab[activeSessionId]?.[activeTabId]
      : undefined,
  );
  const showHidden = useFileExplorerStore((state) => state.showHidden);
  const searchFilter = useFileExplorerStore((state) => state.searchFilter);
  const renamingPath = useFileExplorerStore((state) => state.renamingPath);
  const creatingInPath = useFileExplorerStore((state) => state.creatingInPath);
  const creatingType = useFileExplorerStore((state) => state.creatingType);
  const cancelCreating = useFileExplorerStore((state) => state.cancelCreating);
  const cancelRename = useFileExplorerStore((state) => state.cancelRename);

  const [debouncedFilter, setDebouncedFilter] = useState(searchFilter);
  const [announcement, setAnnouncement] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<FixedSizeList<VirtualFileTreeRowData> | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>());
  const pendingFocusPathRef = useRef<string | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const externalDragPathsRef = useRef<string[]>([]);
  const [listHeight, setListHeight] = useState(0);
  const [dragPreview, setDragPreview] = useState<{
    x: number;
    y: number;
    label: string;
    action: "Move" | "Import";
  } | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedFilter(searchFilter), 150);
    return () => clearTimeout(timeout);
  }, [searchFilter]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateHeight = () => {
      setListHeight(element.clientHeight);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selectedPaths = explorerUiState?.selectedPaths ?? EMPTY_PATH_SET;
  const expandedPaths = explorerUiState?.expandedPaths ?? EMPTY_PATH_SET;
  const focusedPath = explorerUiState?.focusedPath ?? null;
  const lastSelectedPath = explorerUiState?.lastSelectedPath ?? null;
  const visibleRowOrder = explorerUiState?.visibleRowOrder ?? EMPTY_PATHS;
  const directoryPaths = explorerUiState?.directoryPaths ?? EMPTY_PATH_SET;
  const draggingPaths = explorerUiState?.drag.draggingPaths ?? EMPTY_PATHS;
  const dragOverPath = explorerUiState?.drag.dragOverPath ?? null;
  const dropTargetDir = explorerUiState?.drag.dropTargetDir ?? null;

  const {
    rows,
    rootEntries,
    rootLoading,
    rootError,
    visibleEntryPaths,
    visibleDirectoryPaths,
    visibleIndexByPath,
    entryRowByPath,
    firstVisiblePath,
    totalEntryCount,
    shownEntryCount,
    invalidateAllLoaded,
  } = useFlattenedFileTree(
    rootDirectory,
    showHidden,
    expandedPaths,
    debouncedFilter,
    creatingInPath,
    creatingType,
  );

  const effectiveFocusedPath =
    focusedPath && visibleIndexByPath.has(focusedPath) ? focusedPath : firstVisiblePath;

  useEffect(() => {
    if (!activeSessionId || !activeTabId) return;
    setExplorerVisibleRows(activeSessionId, activeTabId, visibleEntryPaths, visibleDirectoryPaths);
  }, [
    activeSessionId,
    activeTabId,
    setExplorerVisibleRows,
    visibleDirectoryPaths,
    visibleEntryPaths,
  ]);

  useEffect(() => {
    if (!activeSessionId || !activeTabId) return;
    clearExplorerSelection(activeSessionId, activeTabId);
    clearExplorerExpandedPaths(activeSessionId, activeTabId);
    clearExplorerFocusedPath(activeSessionId, activeTabId);
    resetExplorerDragState(activeSessionId, activeTabId);
  }, [
    activeSessionId,
    activeTabId,
    clearExplorerExpandedPaths,
    clearExplorerFocusedPath,
    clearExplorerSelection,
    resetExplorerDragState,
    rootDirectory,
  ]);

  useEffect(() => {
    if (!activeSessionId || !activeTabId) return;
    if (visibleRowOrder.length === 0) {
      if (focusedPath !== null) {
        clearExplorerFocusedPath(activeSessionId, activeTabId);
      }
      return;
    }
    if (effectiveFocusedPath !== focusedPath) {
      setExplorerFocusedPath(activeSessionId, activeTabId, effectiveFocusedPath);
    }
  }, [
    activeSessionId,
    activeTabId,
    clearExplorerFocusedPath,
    effectiveFocusedPath,
    focusedPath,
    setExplorerFocusedPath,
    visibleRowOrder,
  ]);

  useEffect(() => {
    const pendingPath = pendingFocusPathRef.current;
    if (!pendingPath || pendingPath !== effectiveFocusedPath) return;

    const index = visibleIndexByPath.get(pendingPath);
    if (index == null) {
      pendingFocusPathRef.current = null;
      return;
    }

    listRef.current?.scrollToItem(index, "smart");
    const frameId = window.requestAnimationFrame(() => {
      const rowElement = rowElementsRef.current.get(pendingPath);
      if (rowElement && rowElement !== rowElement.ownerDocument.activeElement) {
        rowElement.focus();
      }
      if (pendingFocusPathRef.current === pendingPath) {
        pendingFocusPathRef.current = null;
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [effectiveFocusedPath, visibleIndexByPath]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const setupListener = async () => {
      unlisten = await listen<FileChangeBatchEvent>("file-change", (event) => {
        if (cancelled) return;
        const dirs = event.payload.changedDirs ?? [];
        if (dirs.length === 0) return;
        invalidateDirectories(new Set(dirs));
      });
    };

    void setupListener().catch((error) => {
      console.error("Failed to listen for file changes:", error);
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const registerRowElement = useCallback((path: string, element: HTMLDivElement | null) => {
    if (element) {
      rowElementsRef.current.set(path, element);
    } else {
      rowElementsRef.current.delete(path);
    }
  }, []);

  const requestFocusedPath = useCallback(
    (path: string | null, focusDom = false) => {
      if (!activeSessionId || !activeTabId) return;
      pendingFocusPathRef.current = focusDom ? path : null;
      setExplorerFocusedPath(activeSessionId, activeTabId, path);
    },
    [activeSessionId, activeTabId, setExplorerFocusedPath],
  );

  const selectSinglePath = useCallback(
    (path: string, focusDom = false) => {
      if (!activeSessionId || !activeTabId) return;
      setExplorerSelectedPaths(
        activeSessionId,
        activeTabId,
        getSinglePathSelection(path, selectedPaths),
      );
      setExplorerLastSelectedPath(activeSessionId, activeTabId, path);
      requestFocusedPath(path, focusDom);
    },
    [
      activeSessionId,
      activeTabId,
      requestFocusedPath,
      selectedPaths,
      setExplorerLastSelectedPath,
      setExplorerSelectedPaths,
    ],
  );

  const selectRangeToPath = useCallback(
    (targetPath: string, focusDom = false) => {
      if (!activeSessionId || !activeTabId) return;
      const anchorPath = lastSelectedPath ?? effectiveFocusedPath ?? targetPath;
      const anchorIndex = visibleIndexByPath.get(anchorPath);
      const targetIndex = visibleIndexByPath.get(targetPath);

      if (anchorIndex == null || targetIndex == null) {
        selectSinglePath(targetPath, focusDom);
        return;
      }

      const [start, end] =
        anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      setExplorerSelectedPaths(
        activeSessionId,
        activeTabId,
        getRangeSelection(visibleRowOrder, start, end, selectedPaths),
      );
      if (lastSelectedPath == null) {
        setExplorerLastSelectedPath(activeSessionId, activeTabId, anchorPath);
      }
      requestFocusedPath(targetPath, focusDom);
    },
    [
      activeSessionId,
      activeTabId,
      effectiveFocusedPath,
      lastSelectedPath,
      requestFocusedPath,
      selectSinglePath,
      setExplorerLastSelectedPath,
      setExplorerSelectedPaths,
      selectedPaths,
      visibleIndexByPath,
      visibleRowOrder,
    ],
  );

  const moveFocusToPath = useCallback(
    (path: string, extendRange = false) => {
      if (extendRange) {
        selectRangeToPath(path, true);
      } else {
        selectSinglePath(path, true);
      }
    },
    [selectRangeToPath, selectSinglePath],
  );

  const remapExplorerState = useCallback(
    (
      movedMap: Map<string, string>,
      options?: {
        selectedPaths?: Set<string>;
        focusedPath?: string | null;
        lastSelectedPath?: string | null;
      },
    ) => {
      if (!activeSessionId || !activeTabId) return;
      const explorerState =
        useTabStore.getState().explorerStateBySessionTab[activeSessionId]?.[activeTabId];
      if (!explorerState) return;

      const nextExpandedPaths = remapPathSet(explorerState.expandedPaths, movedMap);
      const nextSelectedPaths =
        options?.selectedPaths ?? remapPathSet(explorerState.selectedPaths, movedMap);
      const nextFocusedPath =
        options?.focusedPath ??
        (explorerState.focusedPath ? remapPath(explorerState.focusedPath, movedMap) : null);
      const nextLastSelectedPath =
        options?.lastSelectedPath ??
        (explorerState.lastSelectedPath
          ? remapPath(explorerState.lastSelectedPath, movedMap)
          : null);

      setExplorerExpandedPaths(activeSessionId, activeTabId, nextExpandedPaths);
      setExplorerSelectedPaths(activeSessionId, activeTabId, nextSelectedPaths);
      setExplorerFocusedPath(activeSessionId, activeTabId, nextFocusedPath);
      setExplorerLastSelectedPath(activeSessionId, activeTabId, nextLastSelectedPath);
    },
    [
      activeSessionId,
      activeTabId,
      setExplorerExpandedPaths,
      setExplorerFocusedPath,
      setExplorerLastSelectedPath,
      setExplorerSelectedPaths,
    ],
  );

  const handleCreateSubmit = useCallback(
    async (parentPath: string, name: string, type: "file" | "directory") => {
      if (!name.trim()) {
        cancelCreating();
        return;
      }

      try {
        const createdPath =
          type === "file"
            ? await createFile(rootDirectory ?? parentPath, parentPath, name.trim())
            : await createDirectory(rootDirectory ?? parentPath, parentPath, name.trim());
        invalidateDirectories(new Set([parentPath]));
        setAnnouncement(
          `${type === "file" ? "Created file" : "Created folder"} ${basename(createdPath)}.`,
        );
      } catch (error) {
        console.error(`Failed to create ${type}:`, error);
        setAnnouncement(`Failed to create ${type}.`);
      }
      cancelCreating();
    },
    [cancelCreating, rootDirectory],
  );

  const handleRenameSubmit = useCallback(
    async (oldPath: string, newName: string) => {
      if (!newName.trim()) {
        cancelRename();
        return;
      }

      try {
        const newPath = await renamePath(rootDirectory ?? oldPath, oldPath, newName.trim());
        const parentPath = getParentPath(oldPath, rootDirectory ?? "");
        invalidateDirectories(new Set([parentPath]));

        if (activeSessionId && activeTabId) {
          const tab = getActiveTabFromStore(activeSessionId, activeTabId);
          if (tab) {
            const panel = tab.panels.find(
              (entry) =>
                entry.type === MONACO_PANEL_TYPE &&
                (entry.state as { filePath?: string })?.filePath === oldPath,
            );
            if (panel) {
              updatePanelState(activeSessionId, activeTabId, panel.id, {
                ...(panel.state ?? {}),
                filePath: newPath,
              });
              updatePanel(activeSessionId, activeTabId, panel.id, {
                name: basename(newPath),
              });
            }
          }
        }

        remapExplorerState(new Map([[oldPath, newPath]]));
        setAnnouncement(`Renamed ${basename(oldPath)} to ${basename(newPath)}.`);
      } catch (error) {
        console.error("Failed to rename:", error);
        setAnnouncement("Failed to rename item.");
      }
      cancelRename();
    },
    [
      activeSessionId,
      activeTabId,
      cancelRename,
      remapExplorerState,
      rootDirectory,
      updatePanel,
      updatePanelState,
    ],
  );

  const handlePreviewFile = useCallback(
    async (path: string) => {
      if (!activeSessionId || !activeTabId) return;

      const tab = getActiveTabFromStore(activeSessionId, activeTabId);
      if (!tab) return;

      const existingPanel = tab.panels.find(
        (panel) =>
          panel.type === MONACO_PANEL_TYPE &&
          (panel.state as { filePath?: string })?.filePath === path,
      );
      if (existingPanel) {
        setActivePanel(activeSessionId, tab.id, existingPanel.id);
        return;
      }

      const existingPreviewPanel = tab.panels.find(
        (panel) => panel.type === MONACO_PANEL_TYPE && panel.preview,
      );
      if (existingPreviewPanel) {
        const confirmed = await confirmPanelAction(existingPreviewPanel.id, "replace-file");
        if (!confirmed) return;
        setActivePanel(activeSessionId, tab.id, existingPreviewPanel.id);
        updatePanelState(activeSessionId, tab.id, existingPreviewPanel.id, {
          ...(existingPreviewPanel.state ?? {}),
          filePath: path,
        });
        updatePanel(activeSessionId, tab.id, existingPreviewPanel.id, {
          name: basename(path),
        });
        return;
      }

      const panelId = addPanel(activeSessionId, tab.id, MONACO_PANEL_TYPE, {
        preview: true,
        name: basename(path),
      });
      if (panelId) {
        updatePanelState(activeSessionId, activeTabId, panelId, { filePath: path });
      }
    },
    [
      activeSessionId,
      activeTabId,
      addPanel,
      confirmPanelAction,
      setActivePanel,
      updatePanel,
      updatePanelState,
    ],
  );

  const handleOpenFile = useCallback(
    async (path: string) => {
      if (!activeSessionId || !activeTabId) return;

      const tab = getActiveTabFromStore(activeSessionId, activeTabId);
      if (!tab) return;

      const previewPanel = tab.panels.find(
        (panel) =>
          panel.type === MONACO_PANEL_TYPE &&
          panel.preview &&
          (panel.state as { filePath?: string })?.filePath === path,
      );
      if (previewPanel) {
        setActivePanel(activeSessionId, tab.id, previewPanel.id);
        updatePanel(activeSessionId, tab.id, previewPanel.id, { preview: false });
        return;
      }

      const existingPanel = tab.panels.find(
        (panel) =>
          panel.type === MONACO_PANEL_TYPE &&
          !panel.preview &&
          (panel.state as { filePath?: string })?.filePath === path,
      );
      if (existingPanel) {
        setActivePanel(activeSessionId, tab.id, existingPanel.id);
        return;
      }

      const panelId = addPanel(activeSessionId, tab.id, MONACO_PANEL_TYPE, {
        name: basename(path),
      });
      if (panelId) {
        updatePanelState(activeSessionId, activeTabId, panelId, { filePath: path });
      }
    },
    [activeSessionId, activeTabId, addPanel, setActivePanel, updatePanel, updatePanelState],
  );

  const handleSelectPath = useCallback(
    (path: string, event: React.MouseEvent) => {
      if (!activeSessionId || !activeTabId) return;

      if (event.shiftKey && lastSelectedPath) {
        const from = visibleIndexByPath.get(lastSelectedPath);
        const to = visibleIndexByPath.get(path);
        if (from != null && to != null) {
          const [start, end] = from < to ? [from, to] : [to, from];
          setExplorerSelectedPaths(
            activeSessionId,
            activeTabId,
            getRangeSelection(visibleRowOrder, start, end, selectedPaths),
          );
        } else {
          setExplorerSelectedPaths(
            activeSessionId,
            activeTabId,
            getSinglePathSelection(path, selectedPaths),
          );
        }
        setExplorerLastSelectedPath(activeSessionId, activeTabId, path);
        requestFocusedPath(path);
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        toggleExplorerPathSelection(activeSessionId, activeTabId, path);
        setExplorerLastSelectedPath(activeSessionId, activeTabId, path);
        requestFocusedPath(path);
        return;
      }

      selectSinglePath(path);
    },
    [
      activeSessionId,
      activeTabId,
      lastSelectedPath,
      requestFocusedPath,
      selectedPaths,
      selectSinglePath,
      setExplorerLastSelectedPath,
      setExplorerSelectedPaths,
      toggleExplorerPathSelection,
      visibleIndexByPath,
      visibleRowOrder,
    ],
  );

  const handleContextSelectPath = useCallback(
    (path: string) => {
      if (!activeSessionId || !activeTabId) return;
      if (!selectedPaths.has(path)) {
        setExplorerSelectedPaths(
          activeSessionId,
          activeTabId,
          getSinglePathSelection(path, selectedPaths),
        );
        setExplorerLastSelectedPath(activeSessionId, activeTabId, path);
      }
      requestFocusedPath(path);
    },
    [
      activeSessionId,
      activeTabId,
      requestFocusedPath,
      selectedPaths,
      setExplorerLastSelectedPath,
      setExplorerSelectedPaths,
    ],
  );

  const handleToggleDirectory = useCallback(
    (path: string) => {
      if (!activeSessionId || !activeTabId) return;
      toggleExplorerExpandedPath(activeSessionId, activeTabId, path);
    },
    [activeSessionId, activeTabId, toggleExplorerExpandedPath],
  );

  const handleRowFocus = useCallback(
    (path: string) => {
      requestFocusedPath(path);
    },
    [requestFocusedPath],
  );

  const getAdjacentPath = useCallback(
    (path: string, delta: number) => {
      const currentIndex = visibleIndexByPath.get(path);
      if (currentIndex == null) return null;
      const targetIndex = currentIndex + delta;
      if (targetIndex < 0 || targetIndex >= visibleRowOrder.length) return null;
      return visibleRowOrder[targetIndex] ?? null;
    },
    [visibleIndexByPath, visibleRowOrder],
  );

  const getParentVisiblePath = useCallback(
    (path: string) => {
      const currentIndex = visibleIndexByPath.get(path);
      if (currentIndex == null) return null;
      const currentRow = entryRowByPath.get(path);
      if (!currentRow) return null;
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const candidatePath = visibleRowOrder[index];
        if (!candidatePath) continue;
        const candidate = entryRowByPath.get(candidatePath);
        if (!candidate) continue;
        if (candidate.depth < currentRow.depth) {
          return candidate.path;
        }
      }
      return null;
    },
    [entryRowByPath, visibleIndexByPath, visibleRowOrder],
  );

  const getFirstChildPath = useCallback(
    (path: string) => {
      const currentIndex = visibleIndexByPath.get(path);
      if (currentIndex == null) return null;
      const currentRow = entryRowByPath.get(path);
      const nextPath = visibleRowOrder[currentIndex + 1];
      const nextRow = nextPath ? entryRowByPath.get(nextPath) : undefined;
      if (!currentRow || !nextRow) return null;
      return nextRow.depth > currentRow.depth ? nextRow.path : null;
    },
    [entryRowByPath, visibleIndexByPath, visibleRowOrder],
  );

  const handleRowKeyDown = useCallback(
    (path: string, event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!activeSessionId || !activeTabId) return;
      if ((event.target as HTMLElement).closest("input, textarea")) {
        return;
      }

      const currentRow = entryRowByPath.get(path);
      if (!currentRow) return;

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          const nextPath = getAdjacentPath(path, 1);
          if (nextPath) {
            moveFocusToPath(nextPath, event.shiftKey);
          }
          return;
        }
        case "ArrowUp": {
          event.preventDefault();
          const previousPath = getAdjacentPath(path, -1);
          if (previousPath) {
            moveFocusToPath(previousPath, event.shiftKey);
          }
          return;
        }
        case "ArrowRight": {
          if (!currentRow.entry.is_directory) return;
          event.preventDefault();
          if (!currentRow.isExpanded) {
            handleToggleDirectory(path);
            return;
          }
          const childPath = getFirstChildPath(path);
          if (childPath) {
            moveFocusToPath(childPath);
          }
          return;
        }
        case "ArrowLeft": {
          event.preventDefault();
          if (currentRow.entry.is_directory && currentRow.isExpanded) {
            handleToggleDirectory(path);
            return;
          }
          const parentPath = getParentVisiblePath(path);
          if (parentPath) {
            moveFocusToPath(parentPath);
          }
          return;
        }
        case "Home": {
          event.preventDefault();
          const firstPath = visibleRowOrder[0];
          if (firstPath) {
            moveFocusToPath(firstPath, event.shiftKey);
          }
          return;
        }
        case "End": {
          event.preventDefault();
          const lastPath = visibleRowOrder[visibleRowOrder.length - 1];
          if (lastPath) {
            moveFocusToPath(lastPath, event.shiftKey);
          }
          return;
        }
        case "Enter": {
          event.preventDefault();
          if (currentRow.entry.is_directory) {
            handleToggleDirectory(path);
          } else {
            void handleOpenFile(path);
          }
          return;
        }
        case " ": {
          event.preventDefault();
          toggleExplorerPathSelection(activeSessionId, activeTabId, path);
          setExplorerLastSelectedPath(activeSessionId, activeTabId, path);
          requestFocusedPath(path);
          return;
        }
        case "Escape": {
          event.preventDefault();
          clearExplorerSelection(activeSessionId, activeTabId);
          requestFocusedPath(path);
          setAnnouncement("Selection cleared.");
          return;
        }
        default:
          return;
      }
    },
    [
      activeSessionId,
      activeTabId,
      clearExplorerSelection,
      entryRowByPath,
      getAdjacentPath,
      getFirstChildPath,
      getParentVisiblePath,
      handleOpenFile,
      handleToggleDirectory,
      moveFocusToPath,
      requestFocusedPath,
      setExplorerLastSelectedPath,
      toggleExplorerPathSelection,
      visibleRowOrder,
    ],
  );

  const updateMonacoPathsAfterMove = useCallback(
    (movedMap: Map<string, string>) => {
      if (!activeSessionId || !activeTabId) return;
      const tab = getActiveTabFromStore(activeSessionId, activeTabId);
      if (!tab) return;

      for (const panel of tab.panels) {
        if (panel.type !== MONACO_PANEL_TYPE) continue;
        const currentPath = (panel.state as { filePath?: string } | undefined)?.filePath;
        if (!currentPath) continue;

        const nextPath = remapPath(currentPath, movedMap);
        if (nextPath === currentPath) continue;

        updatePanelState(activeSessionId, activeTabId, panel.id, {
          ...(panel.state ?? {}),
          filePath: nextPath,
        });
        updatePanel(activeSessionId, activeTabId, panel.id, { name: basename(nextPath) });
      }
    },
    [activeSessionId, activeTabId, updatePanel, updatePanelState],
  );

  const performMove = useCallback(
    async (destinationDir: string, draggingOverride?: string[]) => {
      if (!activeSessionId || !activeTabId) return;
      const currentDragging = draggingOverride ?? draggingPaths;
      if (currentDragging.length === 0) return;

      const prunedPaths = pruneNestedSelections(currentDragging, directoryPaths);
      const invalidTarget = prunedPaths.some((dragPath) =>
        isDescendantPath(dragPath, destinationDir),
      );
      if (invalidTarget) return;

      try {
        const movedMap = await movePaths(
          rootDirectory ?? destinationDir,
          prunedPaths,
          destinationDir,
        );
        const invalidateTargets = new Set<string>([destinationDir]);
        for (const oldPath of prunedPaths) {
          invalidateTargets.add(getParentPath(oldPath, rootDirectory ?? destinationDir));
        }
        invalidateDirectories(invalidateTargets);
        updateMonacoPathsAfterMove(movedMap);

        const nextMovedSelection = new Set(Array.from(movedMap.values()));
        const movedSelection = pathSetEquals(nextMovedSelection, selectedPaths)
          ? selectedPaths
          : nextMovedSelection;
        const nextFocusedPath = Array.from(movedSelection)[0] ?? null;
        remapExplorerState(movedMap, {
          selectedPaths: movedSelection,
          focusedPath: nextFocusedPath,
          lastSelectedPath: nextFocusedPath,
        });
        if (nextFocusedPath) {
          pendingFocusPathRef.current = nextFocusedPath;
        }
        setAnnouncement(
          `Moved ${prunedPaths.length === 1 ? basename(prunedPaths[0] ?? "") : `${prunedPaths.length} items`}.`,
        );
      } catch (error) {
        console.error("Failed to move paths:", error);
        setAnnouncement("Failed to move selected items.");
      } finally {
        resetExplorerDragState(activeSessionId, activeTabId);
      }
    },
    [
      activeSessionId,
      activeTabId,
      directoryPaths,
      draggingPaths,
      remapExplorerState,
      resetExplorerDragState,
      rootDirectory,
      selectedPaths,
      updateMonacoPathsAfterMove,
    ],
  );

  const beginPointerDrag = useCallback(
    (path: string, event: React.PointerEvent<HTMLDivElement>) => {
      if (!activeSessionId || !activeTabId) return;
      if (event.button !== 0) return;
      if ((event.target as HTMLElement | null)?.closest("input, button")) return;

      const dragging = selectedPaths.has(path) ? Array.from(selectedPaths) : [path];
      dragCleanupRef.current?.();

      const trigger = event.currentTarget;
      const ownerDocument = trigger.ownerDocument;
      const pointerId = event.pointerId;
      const currentDirectoryPaths = new Set(directoryPaths);
      const startX = event.clientX;
      const startY = event.clientY;
      let dragStarted = false;

      const updateHoveredDropTarget = (clientX: number, clientY: number) => {
        const hovered = ownerDocument.elementFromPoint(clientX, clientY) as HTMLElement | null;
        const { dragOverPath: nextDragOverPath, dropTargetDir: nextDropDir } = resolveDropTarget(
          hovered,
          rootDirectory,
        );

        if (!nextDropDir) {
          setExplorerDragState(activeSessionId, activeTabId, {
            dragOverPath: null,
            dropTargetDir: null,
          });
          return;
        }

        const prunedPaths = pruneNestedSelections(dragging, currentDirectoryPaths);
        const invalidTarget = prunedPaths.some((dragPath) =>
          isDescendantPath(dragPath, nextDropDir),
        );
        if (invalidTarget) {
          setExplorerDragState(activeSessionId, activeTabId, {
            dragOverPath: null,
            dropTargetDir: null,
          });
          return;
        }

        setExplorerDragState(activeSessionId, activeTabId, {
          dragOverPath: nextDragOverPath,
          dropTargetDir: nextDropDir,
        });
      };

      const cleanup = () => {
        ownerDocument.removeEventListener("pointermove", handlePointerMove);
        ownerDocument.removeEventListener("pointerup", handlePointerUp);
        ownerDocument.removeEventListener("pointercancel", handlePointerCancel);
        if (dragCleanupRef.current === cleanup) {
          dragCleanupRef.current = null;
        }
        if (trigger.hasPointerCapture(pointerId)) {
          trigger.releasePointerCapture(pointerId);
        }
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;

        const movedX = moveEvent.clientX - startX;
        const movedY = moveEvent.clientY - startY;
        if (!dragStarted) {
          if (Math.hypot(movedX, movedY) < 4) {
            return;
          }

          dragStarted = true;
          event.preventDefault();
          if (!selectedPaths.has(path)) {
            setExplorerSelectedPaths(
              activeSessionId,
              activeTabId,
              getSinglePathSelection(path, selectedPaths),
            );
            setExplorerLastSelectedPath(activeSessionId, activeTabId, path);
            requestFocusedPath(path);
          }
          setExplorerDragState(activeSessionId, activeTabId, {
            draggingPaths: dragging,
            dragOverPath: null,
            dropTargetDir: null,
          });
          setDragPreview({
            x: moveEvent.clientX,
            y: moveEvent.clientY,
            label: dragging.length > 1 ? `${dragging.length} items` : basename(path),
            action: "Move",
          });
        }

        setDragPreview((current) =>
          current
            ? {
                ...current,
                x: moveEvent.clientX,
                y: moveEvent.clientY,
              }
            : current,
        );
        updateHoveredDropTarget(moveEvent.clientX, moveEvent.clientY);
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;

        if (!dragStarted) {
          cleanup();
          return;
        }

        const destination =
          useTabStore.getState().explorerStateBySessionTab[activeSessionId]?.[activeTabId]?.drag
            .dropTargetDir;

        setDragPreview(null);
        cleanup();

        if (destination) {
          void performMove(destination, dragging);
        } else {
          resetExplorerDragState(activeSessionId, activeTabId);
        }
      };

      const handlePointerCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return;
        setDragPreview(null);
        cleanup();
        if (dragStarted) {
          resetExplorerDragState(activeSessionId, activeTabId);
        }
      };

      trigger.setPointerCapture(pointerId);
      ownerDocument.addEventListener("pointermove", handlePointerMove);
      ownerDocument.addEventListener("pointerup", handlePointerUp);
      ownerDocument.addEventListener("pointercancel", handlePointerCancel);
      dragCleanupRef.current = cleanup;
    },
    [
      activeSessionId,
      activeTabId,
      directoryPaths,
      performMove,
      requestFocusedPath,
      resetExplorerDragState,
      rootDirectory,
      selectedPaths,
      setExplorerDragState,
      setExplorerLastSelectedPath,
      setExplorerSelectedPaths,
    ],
  );

  const clearDragTarget = useCallback(() => {
    if (!activeSessionId || !activeTabId) return;
    setExplorerDragState(activeSessionId, activeTabId, {
      dragOverPath: null,
      dropTargetDir: null,
    });
  }, [activeSessionId, activeTabId, setExplorerDragState]);

  const announceExternalImportResult = useCallback(
    (
      importedCount: number,
      failureCount: number,
      skippedConflicts: number,
      cancelledConflicts: number,
    ) => {
      if (
        importedCount > 0 &&
        failureCount === 0 &&
        skippedConflicts === 0 &&
        cancelledConflicts === 0
      ) {
        setAnnouncement(`Imported ${importedCount === 1 ? "1 item" : `${importedCount} items`}.`);
        return;
      }

      if (importedCount > 0) {
        const parts = [`Imported ${importedCount === 1 ? "1 item" : `${importedCount} items`}`];
        if (failureCount > 0) {
          parts.push(`failed ${failureCount === 1 ? "1 item" : `${failureCount} items`}`);
        }
        const skippedTotal = skippedConflicts + cancelledConflicts;
        if (skippedTotal > 0) {
          parts.push(
            `skipped ${skippedTotal === 1 ? "1 conflicting item" : `${skippedTotal} conflicting items`}`,
          );
        }
        setAnnouncement(`${parts.join(", ")}.`);
        return;
      }

      if (cancelledConflicts > 0 && failureCount === 0) {
        setAnnouncement("Import canceled.");
        return;
      }

      setAnnouncement("Failed to import dropped items.");
    },
    [],
  );

  const mergeImportResults = useCallback(
    (
      left: ImportExternalPathsResult,
      right: ImportExternalPathsResult,
    ): ImportExternalPathsResult => ({
      importedPaths: [...left.importedPaths, ...right.importedPaths],
      conflicts: [...left.conflicts, ...right.conflicts],
      failures: [...left.failures, ...right.failures],
    }),
    [],
  );

  const handleExternalImport = useCallback(
    async (destinationDir: string, sourcePaths: string[]) => {
      if (!rootDirectory || sourcePaths.length === 0) return;

      try {
        let result = await importExternalPaths(rootDirectory, destinationDir, sourcePaths, false);
        let cancelledConflictCount = 0;

        if (result.conflicts.length > 0) {
          const conflictNames = result.conflicts
            .slice(0, 3)
            .map((conflict) => `"${conflict.name}"`)
            .join(", ");
          const overflowCount = result.conflicts.length - Math.min(result.conflicts.length, 3);
          const conflictSummary =
            overflowCount > 0 ? `${conflictNames}, and ${overflowCount} more` : conflictNames;
          const confirmed = await confirm({
            title:
              result.conflicts.length === 1
                ? "Replace existing item?"
                : `Replace ${result.conflicts.length} existing items?`,
            description:
              result.conflicts.length === 1
                ? `${conflictSummary} already exists in the destination. Replace it with the dropped item?`
                : `${conflictSummary} already exist in the destination. Replace them with the dropped items?`,
            confirmLabel: "Replace",
            cancelLabel: "Skip",
            destructive: true,
          });

          if (confirmed) {
            const retryResult = await importExternalPaths(
              rootDirectory,
              destinationDir,
              result.conflicts.map((conflict) => conflict.sourcePath),
              true,
            );
            result = mergeImportResults({ ...result, conflicts: [] }, retryResult);
          } else {
            cancelledConflictCount = result.conflicts.length;
            result = { ...result, conflicts: [] };
          }
        }

        if (result.importedPaths.length > 0) {
          invalidateDirectories(new Set([destinationDir]));
        }

        if (result.failures.length > 0) {
          console.error("Failed to import dropped paths:", result.failures);
        }

        announceExternalImportResult(
          result.importedPaths.length,
          result.failures.length,
          result.conflicts.length,
          cancelledConflictCount,
        );
      } catch (error) {
        console.error("Failed to import dropped paths:", error);
        setAnnouncement("Failed to import dropped items.");
      }
    },
    [announceExternalImportResult, confirm, mergeImportResults, rootDirectory],
  );

  const updateExternalDropUi = useCallback(
    (paths: string[], x: number, y: number) => {
      if (!activeSessionId || !activeTabId) return null;

      const hovered = document.elementFromPoint(x, y) as HTMLElement | null;
      const { dragOverPath: nextDragOverPath, dropTargetDir: nextDropTargetDir } =
        resolveDropTarget(hovered, rootDirectory);

      setExplorerDragState(activeSessionId, activeTabId, {
        dragOverPath: nextDragOverPath,
        dropTargetDir: nextDropTargetDir,
      });
      setDragPreview({
        x,
        y,
        label: paths.length === 1 ? basename(paths[0] ?? "") : `${paths.length} items`,
        action: "Import",
      });

      return nextDropTargetDir;
    },
    [activeSessionId, activeTabId, rootDirectory, setExplorerDragState],
  );

  useEffect(() => {
    if (!rootDirectory) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (cancelled) return;

        if (event.payload.type === "enter") {
          externalDragPathsRef.current = event.payload.paths;
          const logical = event.payload.position.toLogical(window.devicePixelRatio);
          updateExternalDropUi(event.payload.paths, logical.x, logical.y);
          return;
        }

        if (event.payload.type === "over") {
          const logical = event.payload.position.toLogical(window.devicePixelRatio);
          updateExternalDropUi(externalDragPathsRef.current, logical.x, logical.y);
          return;
        }

        if (event.payload.type === "drop") {
          const paths = event.payload.paths;
          externalDragPathsRef.current = [];
          const logical = event.payload.position.toLogical(window.devicePixelRatio);
          const destinationDir = updateExternalDropUi(paths, logical.x, logical.y);

          clearDragTarget();
          setDragPreview(null);

          if (!destinationDir) {
            setAnnouncement("Drop files onto a folder or the workspace root.");
            return;
          }

          void handleExternalImport(destinationDir, paths);
          return;
        }

        externalDragPathsRef.current = [];
        clearDragTarget();
        setDragPreview(null);
      });
    };

    void setup().catch((error) => {
      console.error("Failed to listen for external drag and drop:", error);
    });

    return () => {
      cancelled = true;
      externalDragPathsRef.current = [];
      clearDragTarget();
      setDragPreview(null);
      if (unlisten) {
        unlisten();
      }
    };
  }, [clearDragTarget, handleExternalImport, rootDirectory, updateExternalDropUi]);

  const handleBulkDelete = useCallback(
    async (paths: string[], dirs: Set<string>) => {
      const prunedPaths = pruneNestedSelections(paths, dirs);
      const mutationPlan = await prepareMonacoPanelsForPathRemoval(activeSessionId, prunedPaths);
      if (!mutationPlan) return;

      try {
        if (!rootDirectory) return;
        await deletePaths(rootDirectory, prunedPaths, dirs);
        mutationPlan.closePanels();
        const parents = new Set<string>();
        for (const path of prunedPaths) {
          parents.add(getParentPath(path, rootDirectory ?? ""));
        }
        invalidateDirectories(parents);
        if (activeSessionId && activeTabId) {
          clearExplorerSelection(activeSessionId, activeTabId);
        }
        setAnnouncement(
          `Deleted ${prunedPaths.length === 1 ? basename(prunedPaths[0] ?? "") : `${prunedPaths.length} items`}.`,
        );
      } catch (error) {
        console.error("Failed to delete selected paths:", error);
        setAnnouncement("Failed to delete selected items.");
      }
    },
    [activeSessionId, activeTabId, clearExplorerSelection, rootDirectory],
  );

  const handleBulkCopyPaths = useCallback(async (paths: string[]) => {
    await copyPathsToClipboard(paths).catch(() => {
      console.error("Failed to copy paths to clipboard");
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    try {
      await invalidateAllLoaded();
      setAnnouncement("Explorer refreshed.");
    } catch (error) {
      console.error("Failed to refresh explorer:", error);
      setAnnouncement("Failed to refresh explorer.");
    }
  }, [invalidateAllLoaded]);

  const resultCount = useMemo(
    () => ({ shown: shownEntryCount, total: totalEntryCount }),
    [shownEntryCount, totalEntryCount],
  );
  const liveAnnouncement = rootError ? `Explorer error: ${rootError}` : announcement;

  const rowData = useMemo<VirtualFileTreeRowData>(
    () => ({
      rows,
      rootDirectory: rootDirectory ?? "",
      searchFilter,
      renamingPath,
      focusedPath: effectiveFocusedPath,
      selectedPaths,
      directoryPaths,
      dragOverPath,
      dropTargetDir,
      onSelectPath: handleSelectPath,
      onContextSelectPath: handleContextSelectPath,
      onToggleDirectory: handleToggleDirectory,
      onPreviewFile: handlePreviewFile,
      onOpenFile: handleOpenFile,
      onRenameSubmit: handleRenameSubmit,
      onCancelRename: cancelRename,
      onCreateSubmit: handleCreateSubmit,
      onCancelCreate: cancelCreating,
      onRowPointerDown: beginPointerDrag,
      onRowFocus: handleRowFocus,
      onRowKeyDown: handleRowKeyDown,
      registerRowElement,
      onBulkDelete: handleBulkDelete,
      onBulkCopyPaths: handleBulkCopyPaths,
    }),
    [
      beginPointerDrag,
      cancelCreating,
      cancelRename,
      directoryPaths,
      dragOverPath,
      dropTargetDir,
      effectiveFocusedPath,
      handleBulkCopyPaths,
      handleBulkDelete,
      handleContextSelectPath,
      handleCreateSubmit,
      handleOpenFile,
      handlePreviewFile,
      handleRenameSubmit,
      handleRowFocus,
      handleRowKeyDown,
      handleSelectPath,
      handleToggleDirectory,
      registerRowElement,
      renamingPath,
      rootDirectory,
      rows,
      searchFilter,
      selectedPaths,
    ],
  );

  if (!activeSessionId || !activeTabId) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
        <p className="text-xs">No active tab</p>
      </div>
    );
  }

  if (!rootDirectory) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
        <FolderOpen className="mb-2 h-6 w-6 text-zinc-600" />
        <p className="text-xs">No folder opened</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileExplorerHeader
        rootDirectory={rootDirectory}
        onRefresh={() => {
          void handleRefresh();
        }}
        resultCount={resultCount}
      />
      <div aria-live="polite" className="sr-only">
        {liveAnnouncement}
      </div>
      <div
        ref={viewportRef}
        className="min-h-0 flex-1"
        role="tree"
        aria-label="File explorer"
        aria-multiselectable="true"
      >
        {rootLoading && (
          <div className="flex h-full items-start overflow-y-auto px-2 py-1 text-xs text-zinc-500">
            Loading...
          </div>
        )}
        {rootError && (
          <div className="flex h-full items-start overflow-y-auto px-2 py-1 text-xs text-red-400">
            Error: {rootError}
          </div>
        )}
        {!rootLoading && !rootError && (
          <>
            {rows.length > 0 ? (
              <FixedSizeList
                ref={listRef}
                height={Math.max(listHeight, FILE_TREE_ROW_HEIGHT)}
                width="100%"
                itemCount={rows.length}
                itemSize={FILE_TREE_ROW_HEIGHT}
                itemData={rowData}
                itemKey={(index, data) => data.rows[index]?.key ?? index}
                outerElementType={VirtualListOuter}
                overscanCount={12}
              >
                {VirtualFileTreeRow}
              </FixedSizeList>
            ) : (
              <div data-drop-root="1" className="px-2 py-1 text-xs text-zinc-500">
                {debouncedFilter.trim().length > 0
                  ? "No matching files"
                  : rootEntries.length === 0
                    ? "Empty directory"
                    : "No visible files"}
              </div>
            )}
          </>
        )}
      </div>
      {dragPreview && (
        <div
          className="pointer-events-none fixed z-50 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 shadow-lg"
          style={{
            left: dragPreview.x + 12,
            top: dragPreview.y + 12,
          }}
        >
          {dragPreview.action} {dragPreview.label}
        </div>
      )}
    </div>
  );
}
