import { useEffect } from "react";
import {
  closeDetachedTabWindow,
  emitDetachedTabSnapshot,
  focusSessionOwner,
  listenDetachedTabBounds,
  listenDetachedTabClose,
  listenDetachedTabReady,
  listenDetachedTabReattach,
  listenDetachedTabUpdated,
  updateDetachedTabBounds,
} from "@/lib/detachedTabs";
import { closeBrowserPanelsForTab } from "@/lib/browserPanelLifecycle";
import { confirmTabClose } from "@/lib/tabClose";
import { savePersistedTabState, toPersistedTabMetadata } from "@/lib/tabPersistence";
import { useTabStore } from "@/store/useTabStore";

async function saveSession(sessionId: string) {
  const sessionState = useTabStore.getState().sessionStates[sessionId];
  if (!sessionState) return;
  await savePersistedTabState(sessionId, sessionState);
}

export function useDetachedTabOwnerEvents(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      unlisteners.push(
        await listenDetachedTabReady((payload) => {
          const tab = useTabStore
            .getState()
            .sessionStates[payload.sessionId]?.tabs.find((entry) => entry.id === payload.tabId);
          if (!tab) return;
          void emitDetachedTabSnapshot(
            {
              ...payload,
              ownerLabel: "main",
              tab: toPersistedTabMetadata(tab),
            },
            payload.windowLabel,
          );
        }),
      );

      unlisteners.push(
        await listenDetachedTabUpdated((payload) => {
          const store = useTabStore.getState();
          store.upsertTabFromMetadata(payload.sessionId, payload.tab);
          void saveSession(payload.sessionId).catch((error) => {
            console.error("Failed to save detached tab update:", error);
          });
        }),
      );

      unlisteners.push(
        await listenDetachedTabReattach((payload) => {
          const store = useTabStore.getState();
          store.reattachTab(payload.sessionId, payload.tabId);
          void saveSession(payload.sessionId)
            .then(() => focusSessionOwner(payload.sessionId))
            .then(() => closeDetachedTabWindow(payload.sessionId, payload.tabId))
            .catch((error) => {
              console.error("Failed to reattach detached tab:", error);
            });
        }),
      );

      unlisteners.push(
        await listenDetachedTabClose((payload) => {
          const store = useTabStore.getState();
          const tab = store.sessionStates[payload.sessionId]?.tabs.find(
            (entry) => entry.id === payload.tabId,
          );
          void (async () => {
            if (tab) {
              const confirmed = payload.confirmed ? true : await confirmTabClose(tab);
              if (!confirmed) {
                return;
              }
              await closeBrowserPanelsForTab(tab);
            }
            store.closeTab(payload.sessionId, payload.tabId);
            await saveSession(payload.sessionId);
            await closeDetachedTabWindow(payload.sessionId, payload.tabId);
          })().catch((error) => {
            console.error("Failed to close detached tab:", error);
          });
        }),
      );

      unlisteners.push(
        await listenDetachedTabBounds((payload) => {
          const store = useTabStore.getState();
          store.updateDetachedWindowBounds(payload.sessionId, payload.tabId, payload.bounds);
          void updateDetachedTabBounds(payload.sessionId, payload.tabId, payload.bounds).catch(
            (error) => {
              console.error("Failed to update detached tab bounds:", error);
            },
          );
          void saveSession(payload.sessionId).catch((error) => {
            console.error("Failed to save detached tab bounds:", error);
          });
        }),
      );

      if (disposed) {
        unlisteners.splice(0).forEach((unlisten) => unlisten());
      }
    };

    void setup();

    return () => {
      disposed = true;
      unlisteners.splice(0).forEach((unlisten) => unlisten());
    };
  }, [enabled]);
}
