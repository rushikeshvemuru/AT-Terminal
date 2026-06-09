import { invoke } from "@tauri-apps/api/core";
import { BROWSER_PANEL_TYPE } from "@/lib/panelRegistry";
import type { SessionTabState, Tab } from "@/store/useTabStore";
import type { TabMetadata, TabState } from "@/store/useSessionStore";

interface BrowserPanelHistoryState {
  browserState: {
    url: string;
    history: string[];
  };
  url?: string;
}

function normalizePanelState(
  panelType: string,
  panelState: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!panelState) {
    return null;
  }

  if (panelType !== BROWSER_PANEL_TYPE) {
    return panelState;
  }

  const existingBrowserState = panelState.browserState;
  const browserState =
    existingBrowserState &&
    typeof existingBrowserState === "object" &&
    typeof (existingBrowserState as { url?: unknown }).url === "string" &&
    Array.isArray((existingBrowserState as { history?: unknown }).history)
      ? {
          url: (existingBrowserState as { url: string }).url,
          history: (existingBrowserState as { history: unknown[] }).history.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : null;

  const fallbackUrl =
    typeof panelState.url === "string" && panelState.url.trim().length > 0 ? panelState.url : null;
  const normalizedUrl = browserState?.url ?? fallbackUrl;
  if (!normalizedUrl) {
    return panelState;
  }

  const normalizedHistory =
    browserState && browserState.history.length > 0 ? browserState.history : [normalizedUrl];

  return {
    ...panelState,
    browserState: {
      url: normalizedUrl,
      history: normalizedHistory,
    },
    url: normalizedUrl,
  } satisfies BrowserPanelHistoryState;
}

export function toPersistedState(state: SessionTabState): TabState {
  return {
    tabs: state.tabs.map(toPersistedTabMetadata),
    active_tab_id: state.activeTabId,
  };
}

export function toPersistedTabMetadata(tab: Tab): TabMetadata {
  return {
    id: tab.id,
    name: tab.name,
    color: tab.color ?? null,
    root_directory: tab.rootDirectory,
    panels: tab.panels.map((panel) => ({
      id: panel.id,
      name: panel.name,
      panel_type: panel.type,
      panel_state: normalizePanelState(panel.type, panel.state),
      ...(panel.preview != null ? { preview: panel.preview } : {}),
      ...(panel.hidden ? { hidden: true } : {}),
    })),
    active_panel_id: tab.activePanelId,
    detached: tab.detached ?? false,
    detached_window_bounds: tab.detachedWindowBounds ?? null,
    ...(tab.hidden ? { hidden: true } : {}),
  };
}

export async function savePersistedTabState(sessionId: string, state: SessionTabState) {
  await invoke("save_tab_state", {
    id: sessionId,
    tabState: toPersistedState(state),
  });
}
