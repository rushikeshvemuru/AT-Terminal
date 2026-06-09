import { useState, useRef } from "react";
import { ChevronDown, Eye, Plus, X } from "lucide-react";
import { useTabStore, type Tab, type PanelType } from "@/store/useTabStore";
import { useActiveSessionId } from "@/hooks/useActiveSessionTabState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getPanelColor, useCreatablePanelTypes } from "@/lib/panelRegistry";
import { usePanelGuardStore } from "@/store/usePanelGuardStore";
import { closeBrowserPanelForPanel } from "@/lib/browserPanelLifecycle";

interface PanelBarProps {
  tab: Tab;
}

interface DragState {
  draggingId: string | null;
  dragOverId: string | null;
}

function handleHorizontalWheelScroll(e: React.WheelEvent<HTMLDivElement>) {
  const target = e.currentTarget;
  const maxScrollLeft = target.scrollWidth - target.clientWidth;
  if (maxScrollLeft <= 0) return;

  const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
  if (delta === 0) return;

  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, target.scrollLeft + delta));
  if (nextScrollLeft === target.scrollLeft) return;

  e.preventDefault();
  target.scrollLeft = nextScrollLeft;
}

export const PanelBar = ({ tab }: PanelBarProps) => {
  const sessionId = useActiveSessionId();
  const {
    addPanel,
    removePanel,
    setActivePanel,
    reorderPanels,
    setPanelContextMenu,
    openRenameDialog,
    setPanelHidden,
  } = useTabStore();
  const confirmPanelAction = usePanelGuardStore((s) => s.confirmPanelAction);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [hiddenListOpen, setHiddenListOpen] = useState(false);
  const [dragState, setDragState] = useState<DragState>({
    draggingId: null,
    dragOverId: null,
  });
  const dragOverPanelRef = useRef<string | null>(null);
  const panelTypeEntries = useCreatablePanelTypes();

  if (!sessionId) return null;

  const handleEmptySpaceContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setPanelContextMenu(sessionId, {
      open: true,
      x: e.clientX,
      y: e.clientY,
      panelId: null,
    });
  };

  const panels = tab.panels;
  const visiblePanels = panels.filter((panel) => !panel.hidden);
  const hiddenPanels = panels.filter((panel) => panel.hidden);
  const activePanelId = tab.activePanelId;

  const handleDragStart = (e: React.DragEvent, panelId: string) => {
    setDragState((prev) => ({ ...prev, draggingId: panelId }));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnd = () => {
    if (dragState.draggingId && dragOverPanelRef.current && sessionId) {
      const newOrder = visiblePanels.map((p) => p.id);
      const fromIndex = newOrder.indexOf(dragState.draggingId);
      const toIndex = newOrder.indexOf(dragOverPanelRef.current);

      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        newOrder.splice(toIndex, 0, newOrder.splice(fromIndex, 1)[0]);
        reorderPanels(sessionId, tab.id, mergeVisibleOrderIntoPanelOrder(newOrder));
      }
    }
    setDragState({ draggingId: null, dragOverId: null });
    dragOverPanelRef.current = null;
  };

  const handleDragOver = (e: React.DragEvent, panelId: string) => {
    e.preventDefault();
    if (dragState.draggingId && dragState.draggingId !== panelId) {
      setDragState((prev) => ({ ...prev, dragOverId: panelId }));
      dragOverPanelRef.current = panelId;
    }
  };

  const handleDragLeave = () => {
    setDragState((prev) => ({ ...prev, dragOverId: null }));
    dragOverPanelRef.current = null;
  };

  const handleRemovePanel = async (panelId: string) => {
    const confirmed = await confirmPanelAction(panelId, "close");
    if (!confirmed) return;

    const panel = panels.find((entry) => entry.id === panelId);
    if (panel) {
      await closeBrowserPanelForPanel(panel);
    }
    removePanel(sessionId, tab.id, panelId);
  };

  const mergeVisibleOrderIntoPanelOrder = (visibleIds: string[]) => {
    const visibleQueue = [...visibleIds];
    return panels.map((panel) => {
      if (panel.hidden) return panel.id;
      return visibleQueue.shift() ?? panel.id;
    });
  };

  const handleSelectHiddenPanel = (panelId: string) => {
    setActivePanel(sessionId, tab.id, panelId);
    setHiddenListOpen(false);
  };

  const handleUnhidePanel = (e: React.MouseEvent, panelId: string) => {
    e.stopPropagation();
    setPanelHidden(sessionId, tab.id, panelId, false);
  };

  return (
    <div
      className="flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-1 shadow-[0_0_12px_rgba(255,255,255,0.08)]"
      onContextMenu={handleEmptySpaceContextMenu}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onWheel={handleHorizontalWheelScroll}
      >
        {visiblePanels.map((panel) => {
          const isActive = panel.id === activePanelId;
          const isDragging = dragState.draggingId === panel.id;
          const isDragOver = dragState.dragOverId === panel.id;
          const panelColor = getPanelColor(panel.type);

          return (
            <div
              key={panel.id}
              draggable
              onDragStart={(e) => handleDragStart(e, panel.id)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, panel.id)}
              onDragLeave={handleDragLeave}
              onDrop={() => {}}
              onClick={() => setActivePanel(sessionId, tab.id, panel.id)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (sessionId) {
                  openRenameDialog(sessionId, {
                    kind: "panel",
                    tabId: tab.id,
                    panelId: panel.id,
                  });
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (sessionId) {
                  setPanelContextMenu(sessionId, {
                    open: true,
                    x: e.clientX,
                    y: e.clientY,
                    panelId: panel.id,
                  });
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.stopPropagation();
                  void handleRemovePanel(panel.id);
                }
              }}
              className={`group flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-[color,background-color,border-color,box-shadow,opacity] ${
                isActive
                  ? "bg-zinc-800 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                  : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              } ${isDragging ? "opacity-50" : ""} ${isDragOver ? "ring-1 ring-sky-300" : ""} `}
              style={{
                borderColor: panelColor,
              }}
            >
              <span className={`truncate ${panel.preview ? "italic" : ""}`}>{panel.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleRemovePanel(panel.id);
                }}
                className="rounded-full p-0.5 opacity-0 transition-all hover:bg-white/10 hover:text-zinc-100 group-hover:opacity-100"
                tabIndex={-1}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <Popover open={hiddenListOpen} onOpenChange={setHiddenListOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/20 bg-zinc-900 text-zinc-300 transition-[background-color,color,border-color] hover:border-white/40 hover:bg-zinc-800 hover:text-zinc-100"
            title="Hidden panels"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-56 border-zinc-800 bg-zinc-950 p-1 text-zinc-100 shadow-xl shadow-black/70"
        >
          {hiddenPanels.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-zinc-500">No hidden panels</div>
          ) : (
            hiddenPanels.map((panel) => {
              const isActive = panel.id === activePanelId;
              const panelColor = getPanelColor(panel.type);
              return (
                <div
                  key={panel.id}
                  className="flex min-w-0 items-center gap-1 rounded-sm text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <button
                    type="button"
                    onClick={() => handleSelectHiddenPanel(panel.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                    title={panel.name}
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full border border-white/10"
                      style={{ backgroundColor: panelColor, opacity: isActive ? 1 : 0.75 }}
                    />
                    <span className={`truncate ${panel.preview ? "italic" : ""}`}>
                      {panel.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleUnhidePanel(e, panel.id)}
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                    title="Unhide panel"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </PopoverContent>
      </Popover>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/80 bg-white text-zinc-950 shadow-[0_0_14px_rgba(255,255,255,0.35)] transition-[background-color,color,box-shadow] hover:bg-sky-100 hover:text-sky-950 hover:shadow-[0_0_18px_rgba(186,230,253,0.65)]"
            title="New panel"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-48 border-zinc-800 bg-zinc-950 p-1 text-zinc-100 shadow-xl shadow-black/70"
        >
          {panelTypeEntries.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-zinc-500">No modules available</div>
          ) : (
            panelTypeEntries.map((entry) => (
              <button
                key={entry.type}
                onClick={() => {
                  addPanel(sessionId, tab.id, entry.type as PanelType);
                  setPopoverOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                {entry.displayName}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
};
