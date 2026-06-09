import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minimize2, PanelTopClose } from "lucide-react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { usePanelFullscreenHotkey } from "@/hooks/usePanelFullscreenHotkey";
import {
  emitDetachedTabBounds,
  emitDetachedTabClose,
  emitDetachedTabReady,
  emitDetachedTabReattach,
  emitDetachedTabUpdated,
  getDetachedTabWindowPayload,
  listenDetachedTabSnapshot,
  type DetachedTabWindowPayload,
} from "@/lib/detachedTabs";
import { usePanelFullscreenStore } from "@/store/usePanelFullscreenStore";
import { toPersistedTabMetadata } from "@/lib/tabPersistence";
import { confirmTabClose } from "@/lib/tabClose";
import { useSessionStore, type DetachedWindowBounds, type Session } from "@/store/useSessionStore";
import { useTabStore } from "@/store/useTabStore";
import { Toolbar } from "./Toolbar";
import { PanelBar } from "./PanelBar";
import { PanelWorkspace } from "./PanelWorkspace";
import { PanelContextMenu } from "./PanelContextMenu";
import { FooterBar } from "./FooterBar";
import WindowControls from "./WindowControls";
import { RenameItemDialog } from "./RenameItemDialog";
import { CustomizeTabDialog } from "./CustomizeTabDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { GitAuthDialog } from "./GitAuthDialog";
import { ModulePanelPopupLayer } from "./ModulePanelPopupLayer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type CloseChoice = "reattach" | "close" | "cancel";

export function DetachedTabWindowApp() {
  const [payload, setPayload] = useState<DetachedTabWindowPayload | null>(null);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const allowCloseRef = useRef(false);
  const lastBoundsRef = useRef<Partial<DetachedWindowBounds>>({});
  const boundsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { setActiveSession, setNavState } = useSessionStore();
  const { hydrateFromSession, setActiveTab, upsertTabFromMetadata } = useTabStore();

  const sessionState = useTabStore((state) =>
    payload ? (state.sessionStates[payload.sessionId] ?? null) : null,
  );
  const isPanelFullscreen = usePanelFullscreenStore((s) => s.isPanelFullscreen);
  const exitPanelFullscreen = usePanelFullscreenStore((s) => s.exitPanelFullscreen);
  const tab = useMemo(
    () => sessionState?.tabs.find((entry) => entry.id === payload?.tabId) ?? null,
    [payload?.tabId, sessionState?.tabs],
  );
  const activePanel = tab?.panels.find((entry) => entry.id === tab.activePanelId) ?? null;

  usePanelFullscreenHotkey(activePanel !== null);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      const windowPayload = await getDetachedTabWindowPayload();
      if (disposed) return;
      setPayload(windowPayload);

      const session = await invoke<Session>("open_session", { id: windowPayload.sessionId });
      if (disposed) return;
      setActiveSession(session);
      setNavState("TERMINAL");
      if (session.tab_state) {
        hydrateFromSession(session.id, session.tab_state);
      }
      setActiveTab(windowPayload.sessionId, windowPayload.tabId);

      unlisteners.push(
        await listenDetachedTabSnapshot((eventPayload) => {
          if (
            eventPayload.sessionId !== windowPayload.sessionId ||
            eventPayload.tabId !== windowPayload.tabId
          ) {
            return;
          }
          upsertTabFromMetadata(eventPayload.sessionId, eventPayload.tab);
          setActiveTab(eventPayload.sessionId, eventPayload.tabId);
        }),
      );

      await emitDetachedTabReady(
        {
          sessionId: windowPayload.sessionId,
          tabId: windowPayload.tabId,
          windowLabel: windowPayload.windowLabel,
        },
        windowPayload.ownerLabel,
      );
    };

    void setup().catch((error) => {
      console.error("Failed to initialize detached tab window:", error);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [hydrateFromSession, setActiveSession, setActiveTab, setNavState, upsertTabFromMetadata]);

  useEffect(() => {
    if (!payload || !tab) return;
    const timer = window.setTimeout(() => {
      void emitDetachedTabUpdated(
        {
          ...payload,
          tab: toPersistedTabMetadata(tab),
        },
        payload.ownerLabel,
      ).catch((error) => {
        console.error("Failed to report detached tab update:", error);
      });
    }, 200);

    return () => window.clearTimeout(timer);
  }, [payload, tab]);

  useEffect(() => {
    if (!payload) return;
    const currentWindow = getCurrentWindow();

    const emitBounds = () => {
      if (!payload) return;
      const bounds = lastBoundsRef.current;
      if (
        typeof bounds.x !== "number" ||
        typeof bounds.y !== "number" ||
        typeof bounds.width !== "number" ||
        typeof bounds.height !== "number"
      ) {
        return;
      }
      void emitDetachedTabBounds(
        {
          sessionId: payload.sessionId,
          tabId: payload.tabId,
          windowLabel: payload.windowLabel,
          bounds: bounds as DetachedWindowBounds,
        },
        payload.ownerLabel,
      ).catch((error) => {
        console.error("Failed to report detached tab bounds:", error);
      });
    };

    const scheduleBoundsEmit = () => {
      if (boundsTimerRef.current) {
        window.clearTimeout(boundsTimerRef.current);
      }
      boundsTimerRef.current = window.setTimeout(emitBounds, 250);
    };

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      const position = await currentWindow.outerPosition();
      const size = await currentWindow.outerSize();
      lastBoundsRef.current = {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      };

      unlisteners.push(
        await currentWindow.onMoved(({ payload: positionPayload }) => {
          lastBoundsRef.current = {
            ...lastBoundsRef.current,
            x: positionPayload.x,
            y: positionPayload.y,
          };
          scheduleBoundsEmit();
        }),
      );
      unlisteners.push(
        await currentWindow.onResized(({ payload: sizePayload }) => {
          lastBoundsRef.current = {
            ...lastBoundsRef.current,
            width: sizePayload.width,
            height: sizePayload.height,
          };
          scheduleBoundsEmit();
        }),
      );
      unlisteners.push(
        await currentWindow.onCloseRequested((event) => {
          if (allowCloseRef.current) return;
          event.preventDefault();
          setClosePromptOpen(true);
        }),
      );

      if (disposed) {
        unlisteners.forEach((unlisten) => unlisten());
      }
    };

    void setup().catch((error) => {
      console.error("Failed to watch detached tab window:", error);
    });

    return () => {
      disposed = true;
      if (boundsTimerRef.current) {
        window.clearTimeout(boundsTimerRef.current);
      }
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [payload]);

  useEffect(() => {
    if (!isPanelFullscreen) {
      return;
    }

    if (!tab || !activePanel) {
      exitPanelFullscreen();
    }
  }, [activePanel, exitPanelFullscreen, isPanelFullscreen, tab]);

  const requestOwnerAction = async (choice: CloseChoice) => {
    if (!payload || choice === "cancel") {
      setClosePromptOpen(false);
      return;
    }

    setClosePromptOpen(false);
    const confirmedClose = choice === "close" && Boolean(tab);
    if (confirmedClose && tab) {
      const confirmed = await confirmTabClose(tab);
      if (!confirmed) {
        return;
      }
    }

    const actionPayload = {
      sessionId: payload.sessionId,
      tabId: payload.tabId,
      windowLabel: payload.windowLabel,
      confirmed: confirmedClose || undefined,
    };

    allowCloseRef.current = true;

    if (choice === "reattach") {
      await emitDetachedTabReattach(actionPayload, payload.ownerLabel);
    } else {
      await emitDetachedTabClose(actionPayload, payload.ownerLabel);
    }

    await getCurrentWindow().close();
  };

  const handleReattach = () => {
    void requestOwnerAction("reattach").catch((error) => {
      console.error("Failed to request detached tab reattach:", error);
    });
  };

  const handleCloseChoice = (choice: CloseChoice) => {
    void requestOwnerAction(choice).catch((error) => {
      console.error("Failed to resolve detached tab close:", error);
    });
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div
        data-tauri-drag-region
        className="flex h-10 select-none items-center border-b border-zinc-800/80 bg-zinc-950 px-4"
      >
        <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
          <PanelTopClose className="h-4 w-4 shrink-0 text-zinc-500" />
          <span className="truncate text-sm font-medium text-zinc-100">
            {tab?.name ?? "Detached Tab"}
          </span>
        </div>
        {isPanelFullscreen && (
          <button
            type="button"
            onClick={exitPanelFullscreen}
            className="mr-1 flex h-8 items-center gap-2 rounded-md px-3 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            title="Exit panel fullscreen (Ctrl/Cmd+Shift+F)"
          >
            <Minimize2 className="h-4 w-4" />
            <span>Exit fullscreen</span>
          </button>
        )}
        <WindowControls />
      </div>

      {!isPanelFullscreen && (
        <Toolbar
          showSidePanelToggle={false}
          leading={
            <>
              <button
                type="button"
                onClick={handleReattach}
                className="flex h-7 w-9 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                title="Reattach tab"
              >
                <PanelTopClose className="h-4 w-4" />
              </button>
              <div className="mx-2 h-5 w-px shrink-0 bg-zinc-700" />
            </>
          }
        />
      )}

      <div className="flex-1 overflow-hidden bg-black font-mono text-zinc-100">
        {tab ? (
          <div className={`flex h-full w-full flex-col ${isPanelFullscreen ? "p-0" : "p-4"}`}>
            {!isPanelFullscreen && (
              <>
                <PanelBar tab={tab} />
                <div className="h-1" />
              </>
            )}
            <PanelWorkspace tab={tab} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading tab...
          </div>
        )}
      </div>

      {!isPanelFullscreen && <FooterBar />}
      <PanelContextMenu />
      <RenameItemDialog />
      <CustomizeTabDialog />
      <ConfirmDialog />
      <GitAuthDialog />
      <ModulePanelPopupLayer />

      <Dialog open={closePromptOpen} onOpenChange={(open) => !open && handleCloseChoice("cancel")}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-base">Close detached tab?</DialogTitle>
            <DialogDescription className="text-sm text-zinc-400">
              Reattach this tab to the session, close the tab entirely, or cancel.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => handleCloseChoice("cancel")}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleCloseChoice("close")}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500"
            >
              Close Tab
            </button>
            <button
              type="button"
              onClick={() => handleCloseChoice("reattach")}
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white"
            >
              Reattach
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
