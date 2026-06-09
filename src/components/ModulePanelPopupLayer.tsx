import { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import type { PanelPopupCloseMessage, PanelStatePatchMessage } from "@/lib/panelRegistry";
import { useActiveSessionId, useActiveSessionTabState } from "@/hooks/useActiveSessionTabState";
import { OVERLAY_Z_INDEX } from "@/lib/overlayLayers";
import { usePanelPopupStore } from "@/store/usePanelPopupStore";
import { useTabStore } from "@/store/useTabStore";

const DEFAULT_TITLE = "Module Popup";

export const ModulePanelPopupLayer = () => {
  const activeSessionId = useActiveSessionId();
  const sessionState = useActiveSessionTabState();
  const popups = usePanelPopupStore((s) => s.popups);
  const updatePanelState = useTabStore((s) => s.updatePanelState);
  const closePopupById = usePanelPopupStore((s) => s.closePopupById);
  const closeAllPopups = usePanelPopupStore((s) => s.closeAllPopups);
  const previousSessionIdRef = useRef<string | null | undefined>(activeSessionId);
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const orderedPopups = useMemo(
    () => Object.values(popups).sort((a, b) => a.openedAt - b.openedAt),
    [popups],
  );

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    if (previousSessionId !== undefined && previousSessionId !== activeSessionId) {
      closeAllPopups();
    }
    previousSessionIdRef.current = activeSessionId;
  }, [activeSessionId, closeAllPopups]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (!isPanelPopupCloseMessage(event.data) && !isPanelStatePatchMessage(event.data)) {
        return;
      }

      const popupId =
        "popupId" in event.data && typeof event.data.popupId === "string"
          ? event.data.popupId.trim()
          : "";
      const popup =
        popupId.length > 0
          ? orderedPopups.find((entry) => entry.popupId === popupId)
          : orderedPopups.find((entry) => {
              const iframe = iframeRefs.current[entry.popupId];
              return iframe && event.source === iframe.contentWindow;
            });
      const iframe = popup ? iframeRefs.current[popup.popupId] : null;
      if (!popup || !iframe || event.source !== iframe.contentWindow) {
        return;
      }

      if (isPanelPopupCloseMessage(event.data)) {
        if (popupId.length > 0) {
          closePopupById(popupId);
        }
        return;
      }

      if (!activeSessionId || !sessionState || event.data.panelId !== popup.sourcePanelId) {
        return;
      }

      const tab = sessionState.tabs.find((entry) =>
        entry.panels.some((panel) => panel.id === popup.sourcePanelId),
      );
      const panel = tab?.panels.find((entry) => entry.id === popup.sourcePanelId);
      if (!tab || !panel) {
        return;
      }

      updatePanelState(activeSessionId, tab.id, panel.id, {
        ...(panel.state ?? {}),
        ...event.data.panelState,
      });
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [activeSessionId, closePopupById, orderedPopups, sessionState, updatePanelState]);

  useEffect(() => {
    if (orderedPopups.length === 0) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      const topmost = orderedPopups[orderedPopups.length - 1];
      if (topmost) {
        closePopupById(topmost.popupId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closePopupById, orderedPopups]);

  if (orderedPopups.length === 0) {
    return null;
  }

  return (
    <>
      {orderedPopups.map((popup, index) => {
        const isTopmost = index === orderedPopups.length - 1;
        const width = clampPopupDimension(popup.width, 360, 1200);
        const height = clampPopupDimension(popup.height, 240, 900);
        const title = popup.title.trim() || DEFAULT_TITLE;

        return (
          <div
            key={popup.popupId}
            className="bg-black/82 fixed inset-0 flex items-center justify-center px-4 py-6 backdrop-blur-[3px]"
            style={{ zIndex: OVERLAY_Z_INDEX.modulePopup + index * 10 }}
            onMouseDown={() => {
              if (isTopmost) {
                closePopupById(popup.popupId);
              }
            }}
          >
            <div
              className="flex max-h-full w-full max-w-full flex-col overflow-hidden rounded-xl border border-zinc-700 bg-[#050506] shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_24px_64px_rgba(0,0,0,0.62)]"
              style={{
                width: `min(${width}px, calc(100vw - 2rem))`,
                height: `min(${height}px, calc(100vh - 3rem))`,
              }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="flex items-center gap-3 border-b border-zinc-700 bg-[#030304] px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-zinc-100">{title}</div>
                </div>
                <button
                  type="button"
                  onClick={() => closePopupById(popup.popupId)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  title="Close popup"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <iframe
                ref={(node) => {
                  iframeRefs.current[popup.popupId] = node;
                }}
                title={title}
                src={popup.src}
                className="h-full w-full flex-1 border-0 bg-zinc-950"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            </div>
          </div>
        );
      })}
    </>
  );
};

function clampPopupDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return Math.min(Math.max(720, min), max);
  }

  return Math.min(Math.max(Math.round(value), min), max);
}

function isPanelPopupCloseMessage(value: unknown): value is PanelPopupCloseMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    "type" in value &&
    value.type === "at.panelPopup.close" &&
    (("popupId" in value && typeof value.popupId === "string") ||
      ("panelId" in value && typeof value.panelId === "string"))
  );
}

function isPanelStatePatchMessage(value: unknown): value is PanelStatePatchMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    "type" in value &&
    value.type === "at.panelState.patch" &&
    "panelId" in value &&
    typeof value.panelId === "string" &&
    "panelState" in value &&
    Boolean(value.panelState) &&
    typeof value.panelState === "object"
  );
}
