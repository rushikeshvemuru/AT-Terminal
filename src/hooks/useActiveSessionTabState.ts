import { useMemo, useRef, useSyncExternalStore } from "react";
import { useSessionStore } from "@/store/useSessionStore";
import { useTabStore, type SessionTabState, type Tab } from "@/store/useTabStore";
import type { Panel } from "@/store/useTabStore";

type TabStoreState = ReturnType<typeof useTabStore.getState>;

function useStableTabStoreSelection<T>(
  selector: (state: TabStoreState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const cacheRef = useRef<T | null>(null);

  return useSyncExternalStore(
    useTabStore.subscribe,
    () => {
      const next = selector(useTabStore.getState());
      const previous = cacheRef.current;
      if (previous !== null && isEqual(previous, next)) {
        return previous;
      }
      cacheRef.current = next;
      return next;
    },
    () => selector(useTabStore.getState()),
  );
}

export function useActiveSessionId(): string | null {
  return useSessionStore((s) => s.activeSession?.id) ?? null;
}

export function useSessionTabState(sessionId: string | null): SessionTabState | null {
  return useTabStore((s) => (sessionId ? (s.sessionStates[sessionId] ?? null) : null));
}

export function useActiveSessionTabState(): SessionTabState | null {
  const activeSessionId = useActiveSessionId();
  return useSessionTabState(activeSessionId);
}

export function useActiveTabId(): string | null {
  const activeSessionId = useActiveSessionId();
  return useTabStore((s) =>
    activeSessionId ? (s.sessionStates[activeSessionId]?.activeTabId ?? null) : null,
  );
}

export function useActiveTab(): Tab | null {
  const activeSessionId = useActiveSessionId();
  return useTabStore((s) => {
    if (!activeSessionId) return null;
    const sessionState = s.sessionStates[activeSessionId];
    if (!sessionState) return null;
    return sessionState.tabs.find((tab) => tab.id === sessionState.activeTabId) ?? null;
  });
}

export function useActivePanel(): Panel | null {
  const activeTab = useActiveTab();

  return useMemo(() => {
    if (!activeTab || !activeTab.activePanelId) return null;
    return activeTab.panels.find((panel) => panel.id === activeTab.activePanelId) ?? null;
  }, [activeTab]);
}

export function useActiveTabRootDirectory(): string | null {
  const activeSessionId = useActiveSessionId();
  return useTabStore((s) => {
    if (!activeSessionId) return null;
    const sessionState = s.sessionStates[activeSessionId];
    if (!sessionState) return null;
    return (
      sessionState.tabs.find((tab) => tab.id === sessionState.activeTabId)?.rootDirectory ?? null
    );
  });
}

export function useSidePanelOpen(): boolean {
  const activeSessionId = useActiveSessionId();
  return useTabStore((s) =>
    activeSessionId ? (s.sessionStates[activeSessionId]?.sidePanelOpen ?? true) : true,
  );
}

interface ActiveTabSummary {
  tabCount: number;
  activeTabId: string | null;
  activeTabName: string | null;
}

export function useActiveTabSummary(): ActiveTabSummary {
  const activeSessionId = useActiveSessionId();
  return useStableTabStoreSelection(
    (s) => {
      const sessionState = activeSessionId ? s.sessionStates[activeSessionId] : null;
      if (!sessionState) {
        return {
          tabCount: 0,
          activeTabId: null,
          activeTabName: null,
        };
      }

      const activeTab =
        sessionState.tabs.find((tab) => tab.id === sessionState.activeTabId) ?? null;
      return {
        tabCount: sessionState.tabs.length,
        activeTabId: sessionState.activeTabId,
        activeTabName: activeTab?.name ?? null,
      };
    },
    (left, right) =>
      left.tabCount === right.tabCount &&
      left.activeTabId === right.activeTabId &&
      left.activeTabName === right.activeTabName,
  );
}
