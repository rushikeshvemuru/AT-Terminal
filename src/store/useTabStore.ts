import { create } from "zustand";
import type {
  DetachedWindowBounds,
  TabMetadata,
  TabState as PersistedTabState,
} from "./useSessionStore";
import { getPanelMetadata } from "@/lib/panelRegistry";

/** Panel type is a namespaced string: "module.type" (e.g., "base.terminal") */
export type PanelType = string;

const DEFAULT_MONACO_PANEL_NAME = /^Monaco (\d+)$/;

/**
 * Migrate legacy panel types to namespaced format.
 * Handles case variations: "Terminal", "terminal", "TERMINAL" → "base.terminal"
 */
function migratePanelType(type: string): PanelType {
  const normalized = type.toLowerCase();
  const legacyMap: Record<string, string> = {
    terminal: "base.terminal",
    empty: "base.empty",
    browser: "base.browser_preview",
    browser_preview: "base.browser_preview",
    "base.browser": "base.browser_preview",
  };
  return legacyMap[normalized] ?? type;
}

function migrateDefaultPanelName(type: PanelType, name: string): string {
  if (type === "base.monaco") {
    const match = DEFAULT_MONACO_PANEL_NAME.exec(name);
    if (match) {
      return `Editor ${match[1]}`;
    }
  }

  return name;
}

/**
 * Get the display name for a panel type, falling back to the type suffix.
 */
function getPanelDisplayName(type: PanelType): string {
  return getPanelMetadata(type)?.displayName ?? type.split(".")[1] ?? "Panel";
}

/**
 * Get the next sequential number for a new panel of the given type.
 * Looks at existing panels' names (e.g., "Terminal 1", "Terminal 2") to find the max index.
 */
function getNextPanelIndex(panels: Panel[], type: PanelType, excludeId?: string): number {
  const displayName = getPanelDisplayName(type);
  const maxIndex = panels
    .filter((p) => p.type === type && (!excludeId || p.id !== excludeId))
    .reduce((max, p) => {
      const idx = parseInt(p.name.replace(displayName + " ", ""), 10);
      return isNaN(idx) ? max : Math.max(max, idx);
    }, 0);
  return maxIndex + 1;
}

export interface Panel {
  id: string;
  name: string;
  type: PanelType;
  state?: Record<string, unknown>;
  preview?: boolean;
  hidden?: boolean;
}

export type RenameTarget =
  | { kind: "tab"; tabId: string }
  | { kind: "panel"; tabId: string; panelId: string };

interface RenameDialogState {
  open: boolean;
  target: RenameTarget | null;
}

interface CustomizeTabDialogState {
  open: boolean;
  tabId: string | null;
}

export interface Tab {
  id: string;
  name: string;
  color?: string | null;
  rootDirectory: string;
  rootDirectoryMissing?: boolean;
  panels: Panel[];
  activePanelId: string | null;
  detached?: boolean;
  detachedWindowBounds?: DetachedWindowBounds | null;
  hidden?: boolean;
}

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  tabId: string | null;
}

interface PanelContextMenuState {
  open: boolean;
  x: number;
  y: number;
  panelId: string | null;
}

export interface ExplorerDragState {
  draggingPaths: string[];
  dragOverPath: string | null;
  dropTargetDir: string | null;
}

export interface ExplorerInteractionState {
  expandedPaths: Set<string>;
  selectedPaths: Set<string>;
  focusedPath: string | null;
  lastSelectedPath: string | null;
  visibleRowOrder: string[];
  directoryPaths: Set<string>;
  drag: ExplorerDragState;
}

export interface SessionTabState {
  tabs: Tab[];
  activeTabId: string | null;
  contextMenu: ContextMenuState;
  panelContextMenu: PanelContextMenuState;
  renameDialog: RenameDialogState;
  customizeTabDialog: CustomizeTabDialogState;
  sidePanelOpen: boolean;
}

interface TabState {
  sessionStates: Record<string, SessionTabState>;
  explorerStateBySessionTab: Record<string, Record<string, ExplorerInteractionState>>;

  addTab: (sessionId: string, rootDirectory: string) => string;
  closeTab: (sessionId: string, tabId: string) => void;
  setActiveTab: (sessionId: string, tabId: string) => void;
  reorderTabs: (sessionId: string, tabIds: string[]) => void;
  detachTab: (sessionId: string, tabId: string, bounds?: DetachedWindowBounds | null) => void;
  reattachTab: (sessionId: string, tabId: string) => void;
  updateDetachedWindowBounds: (
    sessionId: string,
    tabId: string,
    bounds: DetachedWindowBounds,
  ) => void;
  upsertTabFromMetadata: (sessionId: string, tab: TabMetadata) => void;
  setContextMenu: (sessionId: string, state: Partial<ContextMenuState>) => void;
  setTabRootDirectoryMissing: (sessionId: string, tabId: string, missing: boolean) => void;
  setPanelContextMenu: (sessionId: string, state: Partial<PanelContextMenuState>) => void;
  openRenameDialog: (sessionId: string, target: RenameTarget) => void;
  closeRenameDialog: (sessionId: string) => void;
  openCustomizeTabDialog: (sessionId: string, tabId: string) => void;
  closeCustomizeTabDialog: (sessionId: string) => void;
  renameTab: (sessionId: string, tabId: string, name: string) => void;
  customizeTab: (
    sessionId: string,
    tabId: string,
    updates: { name: string; color: string | null },
  ) => void;
  renamePanel: (sessionId: string, tabId: string, panelId: string, name: string) => void;
  setTabHidden: (sessionId: string, tabId: string, hidden: boolean) => void;
  setPanelHidden: (sessionId: string, tabId: string, panelId: string, hidden: boolean) => void;
  closeTabById: (sessionId: string, tabId: string) => void;
  closeOtherTabs: (sessionId: string, tabId: string) => void;
  closeTabsToRight: (sessionId: string, tabId: string) => void;
  toggleSidePanel: (sessionId: string) => void;
  cleanupSession: (sessionId: string) => void;
  hydrateFromSession: (sessionId: string, tabState: PersistedTabState) => void;
  resetToDefault: (sessionId: string) => void;
  addPanel: (
    sessionId: string,
    tabId: string,
    type: PanelType,
    options?: { preview?: boolean; name?: string },
  ) => string | null;
  removePanel: (sessionId: string, tabId: string, panelId: string) => void;
  setActivePanel: (sessionId: string, tabId: string, panelId: string) => void;
  updatePanelType: (sessionId: string, tabId: string, panelId: string, type: PanelType) => void;
  updatePanelState: (
    sessionId: string,
    tabId: string,
    panelId: string,
    panelState: Record<string, unknown>,
  ) => void;
  updatePanel: (
    sessionId: string,
    tabId: string,
    panelId: string,
    updates: Partial<Pick<Panel, "name" | "preview">>,
  ) => void;
  reorderPanels: (sessionId: string, tabId: string, panelIds: string[]) => void;
  setExplorerVisibleRows: (
    sessionId: string,
    tabId: string,
    visibleRowOrder: string[],
    directoryPaths: Set<string>,
  ) => void;
  toggleExplorerExpandedPath: (sessionId: string, tabId: string, path: string) => void;
  setExplorerExpandedPaths: (sessionId: string, tabId: string, paths: Set<string>) => void;
  clearExplorerExpandedPaths: (sessionId: string, tabId: string) => void;
  setExplorerSelectedPaths: (sessionId: string, tabId: string, paths: Set<string>) => void;
  toggleExplorerPathSelection: (sessionId: string, tabId: string, path: string) => void;
  setExplorerFocusedPath: (sessionId: string, tabId: string, path: string | null) => void;
  clearExplorerFocusedPath: (sessionId: string, tabId: string) => void;
  setExplorerLastSelectedPath: (sessionId: string, tabId: string, path: string | null) => void;
  clearExplorerSelection: (sessionId: string, tabId: string) => void;
  setExplorerDragState: (
    sessionId: string,
    tabId: string,
    drag: Partial<ExplorerDragState>,
  ) => void;
  resetExplorerDragState: (sessionId: string, tabId: string) => void;
  clearExplorerStateForTab: (sessionId: string, tabId: string) => void;
}

const defaultContextMenu: ContextMenuState = { open: false, x: 0, y: 0, tabId: null };
const defaultPanelContextMenu: PanelContextMenuState = { open: false, x: 0, y: 0, panelId: null };

function createSessionTabState(): SessionTabState {
  return {
    tabs: [],
    activeTabId: null,
    contextMenu: { ...defaultContextMenu },
    panelContextMenu: { ...defaultPanelContextMenu },
    renameDialog: { open: false, target: null },
    customizeTabDialog: { open: false, tabId: null },
    sidePanelOpen: true,
  };
}

const defaultExplorerDragState: ExplorerDragState = {
  draggingPaths: [],
  dragOverPath: null,
  dropTargetDir: null,
};

function createExplorerInteractionState(): ExplorerInteractionState {
  return {
    expandedPaths: new Set(),
    selectedPaths: new Set(),
    focusedPath: null,
    lastSelectedPath: null,
    visibleRowOrder: [],
    directoryPaths: new Set(),
    drag: { ...defaultExplorerDragState },
  };
}

function setsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

let tabCounter = 0;

export const useTabStore = create<TabState>((set, get) => ({
  sessionStates: {},
  explorerStateBySessionTab: {},

  addTab: (sessionId, rootDirectory) => {
    tabCounter += 1;
    const dirName = rootDirectory.split(/[/\\]/).filter(Boolean).pop() || `Tab ${tabCounter}`;
    const newTab: Tab = {
      id: `tab-${Date.now()}-${tabCounter}`,
      name: dirName,
      color: null,
      rootDirectory,
      rootDirectoryMissing: false,
      panels: [],
      activePanelId: null,
    };
    set((state) => {
      const sessionState = state.sessionStates[sessionId] ?? createSessionTabState();
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: [...sessionState.tabs, newTab],
            activeTabId: newTab.id,
          },
        },
      };
    });
    return newTab.id;
  },

  closeTab: (sessionId, tabId) => {
    // Module process cleanup is owned by the module host. The store only
    // manages shell UI state.
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const tabIndex = sessionState.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return state;

      const newTabs = sessionState.tabs.filter((t) => t.id !== tabId);
      let newActiveTabId = sessionState.activeTabId;
      if (sessionState.activeTabId === tabId) {
        if (newTabs.length > 0) {
          const newIndex = Math.min(tabIndex, newTabs.length - 1);
          newActiveTabId = newTabs[newIndex].id;
        } else {
          newActiveTabId = null;
        }
      }

      const sessionExplorer = { ...(state.explorerStateBySessionTab[sessionId] ?? {}) };
      delete sessionExplorer[tabId];
      const renameDialog =
        sessionState.renameDialog.open &&
        sessionState.renameDialog.target?.kind === "tab" &&
        sessionState.renameDialog.target.tabId === tabId
          ? { open: false, target: null }
          : sessionState.renameDialog;
      const customizeTabDialog =
        sessionState.customizeTabDialog.open && sessionState.customizeTabDialog.tabId === tabId
          ? { open: false, tabId: null }
          : sessionState.customizeTabDialog;

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: newTabs,
            activeTabId: newActiveTabId,
            renameDialog,
            customizeTabDialog,
          },
        },
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: sessionExplorer,
        },
      };
    });
  },

  setActiveTab: (sessionId, tabId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, activeTabId: tabId },
        },
      };
    });
  },

  reorderTabs: (sessionId, tabIds) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs: Tab[] = [];
      for (const id of tabIds) {
        const tab = sessionState.tabs.find((t) => t.id === id);
        if (tab) newTabs.push(tab);
      }
      const included = new Set(newTabs.map((tab) => tab.id));
      newTabs.push(...sessionState.tabs.filter((tab) => !included.has(tab.id)));
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs },
        },
      };
    });
  },

  detachTab: (sessionId, tabId, bounds) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      const visibleTabs = sessionState.tabs.filter((tab) => !tab.detached && tab.id !== tabId);
      const nextActiveTabId =
        sessionState.activeTabId === tabId
          ? (visibleTabs[0]?.id ?? null)
          : sessionState.activeTabId;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: sessionState.tabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    detached: true,
                    detachedWindowBounds: bounds ?? tab.detachedWindowBounds ?? null,
                  }
                : tab,
            ),
            activeTabId: nextActiveTabId,
          },
        },
      };
    });
  },

  reattachTab: (sessionId, tabId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: sessionState.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, detached: false, detachedWindowBounds: null } : tab,
            ),
            activeTabId: tabId,
          },
        },
      };
    });
  },

  updateDetachedWindowBounds: (sessionId, tabId, bounds) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: sessionState.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, detachedWindowBounds: bounds } : tab,
            ),
          },
        },
      };
    });
  },

  upsertTabFromMetadata: (sessionId, metadata) => {
    const nextTab: Tab = {
      id: metadata.id,
      name: metadata.name,
      color: metadata.color ?? null,
      rootDirectory: metadata.root_directory ?? "",
      rootDirectoryMissing: false,
      panels: (metadata.panels ?? []).map((panel) => {
        const type = migratePanelType(panel.panel_type ?? "Empty");
        return {
          id: panel.id,
          name: migrateDefaultPanelName(type, panel.name),
          type,
          state: panel.panel_state ?? undefined,
          preview: panel.preview ?? undefined,
          hidden: panel.hidden ?? undefined,
        };
      }),
      activePanelId: metadata.active_panel_id ?? null,
      detached: metadata.detached ?? false,
      detachedWindowBounds: metadata.detached_window_bounds ?? null,
      hidden: metadata.hidden ?? undefined,
    };

    set((state) => {
      const sessionState = state.sessionStates[sessionId] ?? createSessionTabState();
      const existing = sessionState.tabs.find((tab) => tab.id === nextTab.id);
      const tabs = existing
        ? sessionState.tabs.map((tab) => (tab.id === nextTab.id ? nextTab : tab))
        : [...sessionState.tabs, nextTab];
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs,
            activeTabId:
              sessionState.activeTabId === null || !nextTab.detached
                ? nextTab.id
                : sessionState.activeTabId,
          },
        },
      };
    });
  },

  setTabRootDirectoryMissing: (sessionId, tabId, missing) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      let changed = false;
      const tabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId || tab.rootDirectoryMissing === missing) {
          return tab;
        }
        changed = true;
        return { ...tab, rootDirectoryMissing: missing };
      });

      if (!changed) {
        return state;
      }

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs },
        },
      };
    });
  },

  setContextMenu: (sessionId, contextMenuState) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId] ?? createSessionTabState();
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            contextMenu: { ...sessionState.contextMenu, ...contextMenuState },
          },
        },
      };
    });
  },

  setPanelContextMenu: (sessionId, panelContextMenuState) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId] ?? createSessionTabState();
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            panelContextMenu: { ...sessionState.panelContextMenu, ...panelContextMenuState },
          },
        },
      };
    });
  },

  openRenameDialog: (sessionId, target) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId] ?? createSessionTabState();
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            renameDialog: { open: true, target },
          },
        },
      };
    });
  },

  closeRenameDialog: (sessionId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            renameDialog: { open: false, target: null },
          },
        },
      };
    });
  },

  openCustomizeTabDialog: (sessionId, tabId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId] ?? createSessionTabState();
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            customizeTabDialog: { open: true, tabId },
          },
        },
      };
    });
  },

  closeCustomizeTabDialog: (sessionId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            customizeTabDialog: { open: false, tabId: null },
          },
        },
      };
    });
  },

  renameTab: (sessionId, tabId, name) => {
    const nextName = name.trim();
    if (!nextName) return;
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: sessionState.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, name: nextName } : tab,
            ),
          },
        },
      };
    });
  },

  customizeTab: (sessionId, tabId, updates) => {
    const nextName = updates.name.trim();
    if (!nextName) return;
    const nextColor = updates.color?.trim() || null;
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: sessionState.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, name: nextName, color: nextColor } : tab,
            ),
          },
        },
      };
    });
  },

  renamePanel: (sessionId, tabId, panelId, name) => {
    const nextName = name.trim();
    if (!nextName) return;
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        return {
          ...tab,
          panels: tab.panels.map((panel) =>
            panel.id === panelId ? { ...panel, name: nextName } : panel,
          ),
        };
      });

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs },
        },
      };
    });
  },

  setTabHidden: (sessionId, tabId, hidden) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      let changed = false;
      const tabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId || Boolean(tab.hidden) === hidden) return tab;
        changed = true;
        return { ...tab, hidden: hidden || undefined };
      });

      if (!changed) return state;

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs },
        },
      };
    });
  },

  setPanelHidden: (sessionId, tabId, panelId, hidden) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      let changed = false;
      const tabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const panels = tab.panels.map((panel) => {
          if (panel.id !== panelId || Boolean(panel.hidden) === hidden) return panel;
          changed = true;
          return { ...panel, hidden: hidden || undefined };
        });
        return changed ? { ...tab, panels } : tab;
      });

      if (!changed) return state;

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs },
        },
      };
    });
  },

  closeTabById: (sessionId, tabId) => {
    get().closeTab(sessionId, tabId);
    get().setContextMenu(sessionId, { open: false });
  },

  closeOtherTabs: (sessionId, tabId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;
      const keptExplorer = state.explorerStateBySessionTab[sessionId]?.[tabId];
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: sessionState.tabs.filter((t) => t.id === tabId),
            activeTabId: tabId,
          },
        },
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: keptExplorer ? { [tabId]: keptExplorer } : {},
        },
      };
    });
    get().setContextMenu(sessionId, { open: false });
  },

  closeTabsToRight: (sessionId, tabId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const tabIndex = sessionState.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return state;

      const newTabs = sessionState.tabs.slice(0, tabIndex + 1);
      const allowedTabIds = new Set(newTabs.map((tab) => tab.id));
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const trimmedExplorer = Object.fromEntries(
        Object.entries(sessionExplorer).filter(([key]) => allowedTabIds.has(key)),
      );
      const renameDialog =
        sessionState.renameDialog.open &&
        sessionState.renameDialog.target &&
        !allowedTabIds.has(sessionState.renameDialog.target.tabId)
          ? { open: false, target: null }
          : sessionState.renameDialog;
      const customizeTabDialog =
        sessionState.customizeTabDialog.open &&
        sessionState.customizeTabDialog.tabId &&
        !allowedTabIds.has(sessionState.customizeTabDialog.tabId)
          ? { open: false, tabId: null }
          : sessionState.customizeTabDialog;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            tabs: newTabs,
            activeTabId: sessionState.tabs.find((t) => t.id === tabId)
              ? tabId
              : sessionState.activeTabId,
            renameDialog,
            customizeTabDialog,
          },
        },
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: trimmedExplorer,
        },
      };
    });
    get().setContextMenu(sessionId, { open: false });
  },

  toggleSidePanel: (sessionId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId] ?? createSessionTabState();
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...sessionState,
            sidePanelOpen: !sessionState.sidePanelOpen,
          },
        },
      };
    });
  },

  cleanupSession: (sessionId) => {
    // Module processes are owned outside the tab store.
    set((state) => {
      const rest = { ...state.sessionStates };
      const explorerRest = { ...state.explorerStateBySessionTab };
      delete rest[sessionId];
      delete explorerRest[sessionId];
      return { sessionStates: rest, explorerStateBySessionTab: explorerRest };
    });
  },

  hydrateFromSession: (sessionId, tabState) => {
    set((state) => ({
      sessionStates: {
        ...state.sessionStates,
        [sessionId]: {
          tabs: tabState.tabs.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color ?? null,
            rootDirectory: t.root_directory ?? "",
            rootDirectoryMissing: false,
            panels: (t.panels ?? []).map((p) => {
              const type = migratePanelType((p as { panel_type?: string }).panel_type ?? "Empty");
              return {
                id: p.id,
                name: migrateDefaultPanelName(type, p.name),
                type,
                state: p.panel_state ?? undefined,
                preview: (p as { preview?: boolean }).preview ?? undefined,
                hidden: (p as { hidden?: boolean }).hidden ?? undefined,
              };
            }),
            activePanelId: t.active_panel_id ?? null,
            detached: t.detached ?? false,
            detachedWindowBounds: t.detached_window_bounds ?? null,
            hidden: t.hidden ?? undefined,
          })),
          activeTabId: tabState.active_tab_id,
          contextMenu: { ...defaultContextMenu },
          panelContextMenu: { ...defaultPanelContextMenu },
          renameDialog: { open: false, target: null },
          customizeTabDialog: { open: false, tabId: null },
          sidePanelOpen: true,
        },
      },
      explorerStateBySessionTab: {
        ...state.explorerStateBySessionTab,
        [sessionId]: {},
      },
    }));
  },

  resetToDefault: (sessionId) => {
    set((state) => ({
      sessionStates: {
        ...state.sessionStates,
        [sessionId]: createSessionTabState(),
      },
      explorerStateBySessionTab: {
        ...state.explorerStateBySessionTab,
        [sessionId]: {},
      },
    }));
  },

  addPanel: (sessionId, tabId, type, options) => {
    let newPanelId: string | null = null;
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const displayName = getPanelDisplayName(type);
        const nextIndex = getNextPanelIndex(tab.panels, type);
        newPanelId = `panel-${Date.now()}-${nextIndex}`;
        const newPanel: Panel = {
          id: newPanelId,
          name: options?.name ?? `${displayName} ${nextIndex}`,
          type,
          ...(options?.preview != null ? { preview: options.preview } : {}),
        };
        return {
          ...tab,
          panels: [...tab.panels, newPanel],
          activePanelId: newPanel.id,
        };
      });

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs },
        },
      };
    });
    return newPanelId;
  },

  removePanel: (sessionId, tabId, panelId) => {
    // Module panel teardown is owned by the module frame/service.
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const newPanels = tab.panels.filter((p) => p.id !== panelId);
        let newActivePanelId = tab.activePanelId;
        if (tab.activePanelId === panelId) {
          newActivePanelId = newPanels.length > 0 ? newPanels[0].id : null;
        }
        return { ...tab, panels: newPanels, activePanelId: newActivePanelId };
      });
      const renameDialog =
        sessionState.renameDialog.open &&
        sessionState.renameDialog.target?.kind === "panel" &&
        sessionState.renameDialog.target.tabId === tabId &&
        sessionState.renameDialog.target.panelId === panelId
          ? { open: false, target: null }
          : sessionState.renameDialog;

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs, renameDialog },
        },
      };
    });
  },

  setActivePanel: (sessionId, tabId, panelId) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        return { ...tab, activePanelId: panelId };
      });

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs },
        },
      };
    });
  },

  updatePanelType: (sessionId, tabId, panelId, type) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const displayName = getPanelDisplayName(type);
        const nextIndex = getNextPanelIndex(tab.panels, type, panelId);
        const newPanels = tab.panels.map((p) => {
          if (p.id !== panelId) return p;
          return { ...p, type, name: `${displayName} ${nextIndex}` };
        });
        return { ...tab, panels: newPanels };
      });

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs },
        },
      };
    });
  },

  updatePanelState: (sessionId, tabId, panelId, panelState) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const newPanels = tab.panels.map((panel) =>
          panel.id === panelId ? { ...panel, state: panelState } : panel,
        );
        return { ...tab, panels: newPanels };
      });

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs },
        },
      };
    });
  },

  updatePanel: (sessionId, tabId, panelId, updates) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const newPanels = tab.panels.map((panel) =>
          panel.id === panelId ? { ...panel, ...updates } : panel,
        );
        return { ...tab, panels: newPanels };
      });

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs },
        },
      };
    });
  },

  reorderPanels: (sessionId, tabId, panelIds) => {
    set((state) => {
      const sessionState = state.sessionStates[sessionId];
      if (!sessionState) return state;

      const newTabs = sessionState.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const reorderedPanels: Panel[] = [];
        for (const id of panelIds) {
          const panel = tab.panels.find((p) => p.id === id);
          if (panel) reorderedPanels.push(panel);
        }
        const included = new Set(reorderedPanels.map((panel) => panel.id));
        reorderedPanels.push(...tab.panels.filter((panel) => !included.has(panel.id)));
        return { ...tab, panels: reorderedPanels };
      });

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...sessionState, tabs: newTabs },
        },
      };
    });
  },

  setExplorerVisibleRows: (sessionId, tabId, visibleRowOrder, directoryPaths) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      const sameRowOrder =
        current.visibleRowOrder.length === visibleRowOrder.length &&
        current.visibleRowOrder.every((path, index) => path === visibleRowOrder[index]);
      const sameDirectorySet = setsEqual(current.directoryPaths, directoryPaths);
      if (sameRowOrder && sameDirectorySet) {
        return state;
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              visibleRowOrder,
              directoryPaths: new Set(directoryPaths),
            },
          },
        },
      };
    });
  },

  toggleExplorerExpandedPath: (sessionId, tabId, path) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      const expandedPaths = new Set(current.expandedPaths);
      if (expandedPaths.has(path)) {
        expandedPaths.delete(path);
      } else {
        expandedPaths.add(path);
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              expandedPaths,
            },
          },
        },
      };
    });
  },

  setExplorerExpandedPaths: (sessionId, tabId, paths) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      const sameExpandedSet = setsEqual(current.expandedPaths, paths);
      if (sameExpandedSet) {
        return state;
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              expandedPaths: new Set(paths),
            },
          },
        },
      };
    });
  },

  clearExplorerExpandedPaths: (sessionId, tabId) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      if (current.expandedPaths.size === 0) {
        return state;
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              expandedPaths: new Set(),
            },
          },
        },
      };
    });
  },

  setExplorerSelectedPaths: (sessionId, tabId, paths) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      if (setsEqual(current.selectedPaths, paths)) {
        return state;
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              selectedPaths: new Set(paths),
            },
          },
        },
      };
    });
  },

  toggleExplorerPathSelection: (sessionId, tabId, path) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      const next = new Set(current.selectedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              selectedPaths: next,
            },
          },
        },
      };
    });
  },

  setExplorerFocusedPath: (sessionId, tabId, path) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      if (current.focusedPath === path) {
        return state;
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              focusedPath: path,
            },
          },
        },
      };
    });
  },

  clearExplorerFocusedPath: (sessionId, tabId) => {
    get().setExplorerFocusedPath(sessionId, tabId, null);
  },

  setExplorerLastSelectedPath: (sessionId, tabId, path) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      if (current.lastSelectedPath === path) {
        return state;
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              lastSelectedPath: path,
            },
          },
        },
      };
    });
  },

  clearExplorerSelection: (sessionId, tabId) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      if (current.selectedPaths.size === 0 && current.lastSelectedPath === null) {
        return state;
      }
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              selectedPaths: new Set(),
              lastSelectedPath: null,
            },
          },
        },
      };
    });
  },

  setExplorerDragState: (sessionId, tabId, drag) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              drag: {
                ...current.drag,
                ...drag,
              },
            },
          },
        },
      };
    });
  },

  resetExplorerDragState: (sessionId, tabId) => {
    set((state) => {
      const sessionExplorer = state.explorerStateBySessionTab[sessionId] ?? {};
      const current = sessionExplorer[tabId] ?? createExplorerInteractionState();
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: {
            ...sessionExplorer,
            [tabId]: {
              ...current,
              drag: { ...defaultExplorerDragState },
            },
          },
        },
      };
    });
  },

  clearExplorerStateForTab: (sessionId, tabId) => {
    set((state) => {
      const sessionExplorer = { ...(state.explorerStateBySessionTab[sessionId] ?? {}) };
      delete sessionExplorer[tabId];
      return {
        explorerStateBySessionTab: {
          ...state.explorerStateBySessionTab,
          [sessionId]: sessionExplorer,
        },
      };
    });
  },
}));
