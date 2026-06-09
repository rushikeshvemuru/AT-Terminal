import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabStore } from "@/store/useTabStore";
import { useActiveSessionId } from "./useActiveSessionTabState";
import { savePersistedTabState, toPersistedState } from "@/lib/tabPersistence";

interface PendingTabState {
  enabled: boolean;
  sessionId: string | null;
  sessionState: ReturnType<typeof useTabStore.getState>["sessionStates"][string] | null;
  serialized: string;
}

export function useTabPersistence(enabled = true) {
  const sessionId = useActiveSessionId();
  const sessionState = useTabStore((s) =>
    sessionId ? (s.sessionStates[sessionId] ?? null) : null,
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const pendingRef = useRef<PendingTabState>({
    enabled,
    sessionId,
    sessionState,
    serialized: "",
  });
  const allowCloseRef = useRef(false);

  const flushPendingSave = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending.enabled || !pending.sessionId || !pending.sessionState) {
      return;
    }

    if (pending.serialized === lastSavedRef.current) {
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    await savePersistedTabState(pending.sessionId, pending.sessionState);
    lastSavedRef.current = pending.serialized;
  }, []);

  useEffect(() => {
    if (!enabled || !sessionId || !sessionState) {
      pendingRef.current = {
        enabled,
        sessionId,
        sessionState,
        serialized: "",
      };
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const persisted = toPersistedState(sessionState);
    const serialized = JSON.stringify(persisted);
    pendingRef.current = {
      enabled,
      sessionId,
      sessionState,
      serialized,
    };
    if (serialized === lastSavedRef.current) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(async () => {
      try {
        await flushPendingSave();
      } catch (e) {
        console.error("Failed to save tab state:", e);
      }
    }, 300);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, flushPendingSave, sessionId, sessionState]);

  useEffect(() => {
    if (!enabled) return;

    const currentWindow = getCurrentWindow();
    let unlisten: (() => void) | null = null;

    void currentWindow
      .onCloseRequested(async (event) => {
        if (allowCloseRef.current) return;
        event.preventDefault();
        try {
          await flushPendingSave();
        } catch (error) {
          console.error("Failed to flush tab state before closing window:", error);
        }
        allowCloseRef.current = true;
        window.setTimeout(() => {
          currentWindow.destroy().catch((error) => {
            allowCloseRef.current = false;
            console.error("Failed to destroy window after flushing tab state:", error);
          });
        }, 0);
      })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch((error) => {
        console.error("Failed to register window close persistence handler:", error);
      });

    return () => {
      unlisten?.();
    };
  }, [enabled, flushPendingSave]);

  useEffect(() => {
    return () => {
      void flushPendingSave().catch((error) => {
        console.error("Failed to flush tab state during cleanup:", error);
      });
    };
  }, [flushPendingSave]);
}
