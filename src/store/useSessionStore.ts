import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "./useTabStore";
import {
  claimSessionWindow,
  closeDetachedTabWindowsForSession,
  openDetachedTabWindow,
  releaseSessionWindow,
} from "@/lib/detachedTabs";
import { savePersistedTabState } from "@/lib/tabPersistence";

export interface PanelMetadata {
  id: string;
  name: string;
  panel_type: string;
  panel_state?: Record<string, unknown> | null;
  preview?: boolean;
  hidden?: boolean;
}

export interface TabMetadata {
  id: string;
  name: string;
  color?: string | null;
  root_directory: string;
  panels: PanelMetadata[];
  active_panel_id: string | null;
  detached?: boolean;
  detached_window_bounds?: DetachedWindowBounds | null;
  hidden?: boolean;
}

export interface TabState {
  tabs: TabMetadata[];
  active_tab_id: string | null;
}

export interface DetachedWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Session {
  id: string;
  name: string;
  created_at: string;
  last_accessed: string;
  session_content: string;
  tab_state?: TabState | null;
}

export type NavigationState =
  | "SESSION_SELECTION"
  | "NEW_SESSION_FORM"
  | "OPEN_SESSION_LIST"
  | "TERMINAL";

interface SessionState {
  navState: NavigationState;
  activeSession: Session | null;
  availableSessions: Session[];

  setNavState: (state: NavigationState) => void;
  setActiveSession: (session: Session | null) => void;
  setAvailableSessions: (sessions: Session[]) => void;
  openSession: (session: Session) => Promise<void>;
  refreshSessions: () => Promise<void>;
  switchToSession: (session: Session) => Promise<void>;
  returnToMainMenu: () => Promise<void>;
  deleteSession: (session: Session) => Promise<void>;
  terminateActiveSession: () => Promise<void>;
}

async function restoreDetachedTabWindows(sessionId: string) {
  const sessionState = useTabStore.getState().sessionStates[sessionId];
  if (!sessionState) return;

  for (const tab of sessionState.tabs) {
    if (!tab.detached) continue;
    try {
      await openDetachedTabWindow(sessionId, tab.id, tab.name, tab.detachedWindowBounds ?? null);
    } catch (error) {
      console.error("Failed to restore detached tab window:", error);
    }
  }
}

async function releaseCurrentSession(session: Session | null) {
  if (!session) return;
  const currentTabState = useTabStore.getState().sessionStates[session.id];
  if (currentTabState) {
    try {
      await savePersistedTabState(session.id, currentTabState);
    } catch (error) {
      console.error("Failed to save current session before switching:", error);
    }
  }

  try {
    await closeDetachedTabWindowsForSession(session.id);
  } catch (error) {
    console.error("Failed to close detached tab windows:", error);
  }

  try {
    await releaseSessionWindow(session.id);
  } catch (error) {
    console.error("Failed to release session window:", error);
  }
}

function hydrateSession(session: Session) {
  const tabStore = useTabStore.getState();
  if (session.tab_state) {
    tabStore.hydrateFromSession(session.id, session.tab_state);
  } else {
    tabStore.resetToDefault(session.id);
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  navState: "SESSION_SELECTION",
  activeSession: null,
  availableSessions: [],

  setNavState: (state) => set({ navState: state }),
  setActiveSession: (session) => set({ activeSession: session }),
  setAvailableSessions: (sessions) => set({ availableSessions: sessions }),
  openSession: async (session) => {
    try {
      if (get().activeSession?.id === session.id) {
        set({ navState: "TERMINAL" });
        return;
      }
      const claim = await claimSessionWindow(session.id);
      if (claim.status === "focusedExisting") return;
      await releaseCurrentSession(get().activeSession);
      set({ activeSession: session, navState: "TERMINAL" });
      hydrateSession(session);
      await restoreDetachedTabWindows(session.id);
    } catch (error) {
      console.error("Failed to open session:", error);
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await invoke<Session[]>("list_sessions");
      set({ availableSessions: sessions });
    } catch (e) {
      console.error("Failed to refresh sessions:", e);
    }
  },

  switchToSession: async (session) => {
    try {
      if (get().activeSession?.id === session.id) {
        set({ navState: "TERMINAL" });
        return;
      }
      const claim = await claimSessionWindow(session.id);
      if (claim.status === "focusedExisting") return;
      await releaseCurrentSession(get().activeSession);
      const updatedSession = await invoke<Session>("open_session", { id: session.id });
      set({ activeSession: updatedSession, navState: "TERMINAL" });
      hydrateSession(updatedSession);
      await restoreDetachedTabWindows(updatedSession.id);
    } catch (e) {
      console.error("Failed to switch session:", e);
      set({ activeSession: session, navState: "TERMINAL" });
      hydrateSession(session);
    }
  },

  returnToMainMenu: async () => {
    const session = get().activeSession;
    await releaseCurrentSession(session);
    set({ activeSession: null, navState: "SESSION_SELECTION" });
  },

  deleteSession: async (session) => {
    if (!session) return;
    const isActiveSession = get().activeSession?.id === session.id;

    try {
      await closeDetachedTabWindowsForSession(session.id);
    } catch (error) {
      console.error("Failed to close detached tab windows:", error);
    }

    try {
      await invoke("delete_session", { id: session.id });
    } catch (error) {
      console.error("Failed to delete session:", error);
      throw error;
    }

    try {
      await releaseSessionWindow(session.id);
    } catch (error) {
      console.error("Failed to release session window:", error);
    }

    useTabStore.getState().cleanupSession(session.id);
    set((state) => ({
      activeSession: isActiveSession ? null : state.activeSession,
      navState: isActiveSession ? "SESSION_SELECTION" : state.navState,
      availableSessions: state.availableSessions.filter((entry) => entry.id !== session.id),
    }));
  },

  terminateActiveSession: async () => {
    const session = get().activeSession;
    if (!session) return;
    await get().deleteSession(session);
  },
}));
