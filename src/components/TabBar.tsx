import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Eye, Plus, X } from "lucide-react";
import { useTabStore } from "@/store/useTabStore";
import { useActiveSessionId } from "@/hooks/useActiveSessionTabState";
import { closeBrowserPanelsForTab } from "@/lib/browserPanelLifecycle";
import { openDetachedTabWindow, waitForOwnerDetachRender } from "@/lib/detachedTabs";
import { confirmTabClose } from "@/lib/tabClose";
import { savePersistedTabState } from "@/lib/tabPersistence";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NewTabDialog } from "./NewTabDialog";

interface DragState {
  draggingId: string | null;
  dragOverId: string | null;
}

interface TabBarTabView {
  id: string;
  name: string;
  color: string | null | undefined;
  detached: boolean | undefined;
  hidden: boolean | undefined;
  rootDirectoryMissing: boolean | undefined;
  rootDirectory: string;
  detachedWindowBounds:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | null
    | undefined;
}

function tabViewEquals(left: TabBarTabView, right: TabBarTabView): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.color === right.color &&
    left.detached === right.detached &&
    left.hidden === right.hidden &&
    left.rootDirectoryMissing === right.rootDirectoryMissing &&
    left.rootDirectory === right.rootDirectory &&
    left.detachedWindowBounds?.x === right.detachedWindowBounds?.x &&
    left.detachedWindowBounds?.y === right.detachedWindowBounds?.y &&
    left.detachedWindowBounds?.width === right.detachedWindowBounds?.width &&
    left.detachedWindowBounds?.height === right.detachedWindowBounds?.height
  );
}

function tabViewArrayEquals(left: TabBarTabView[], right: TabBarTabView[]): boolean {
  return (
    left.length === right.length && left.every((tab, index) => tabViewEquals(tab, right[index]!))
  );
}

interface TabBarStateSnapshot {
  attachedTabs: TabBarTabView[];
  tabs: TabBarTabView[];
  hiddenTabs: TabBarTabView[];
  activeTabId: string | null;
}

function tabBarStateEquals(left: TabBarStateSnapshot, right: TabBarStateSnapshot): boolean {
  return (
    left.activeTabId === right.activeTabId &&
    tabViewArrayEquals(left.attachedTabs, right.attachedTabs) &&
    tabViewArrayEquals(left.tabs, right.tabs) &&
    tabViewArrayEquals(left.hiddenTabs, right.hiddenTabs)
  );
}

function buildTabBarState(sessionId: string | null): TabBarStateSnapshot {
  const sessionState = sessionId ? useTabStore.getState().sessionStates[sessionId] : null;
  const allTabs =
    sessionState?.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      color: tab.color,
      detached: tab.detached,
      hidden: tab.hidden,
      rootDirectoryMissing: tab.rootDirectoryMissing,
      rootDirectory: tab.rootDirectory,
      detachedWindowBounds: tab.detachedWindowBounds,
    })) ?? [];
  const attachedTabs = allTabs.filter((tab) => !tab.detached);
  return {
    attachedTabs,
    tabs: attachedTabs.filter((tab) => !tab.hidden),
    hiddenTabs: attachedTabs.filter((tab) => tab.hidden),
    activeTabId: sessionState?.activeTabId ?? null,
  };
}

const TAB_DETACH_DISTANCE_PX = 72;

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

export const TabBar = () => {
  const sessionId = useActiveSessionId();
  const snapshotRef = useRef<TabBarStateSnapshot | null>(null);
  const { attachedTabs, tabs, hiddenTabs, activeTabId } = useSyncExternalStore(
    useTabStore.subscribe,
    () => {
      const next = buildTabBarState(sessionId);
      const previous = snapshotRef.current;
      if (previous && tabBarStateEquals(previous, next)) {
        return previous;
      }
      snapshotRef.current = next;
      return next;
    },
    () => buildTabBarState(sessionId),
  );
  const addTab = useTabStore((s) => s.addTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const reorderTabs = useTabStore((s) => s.reorderTabs);
  const detachTab = useTabStore((s) => s.detachTab);
  const setContextMenu = useTabStore((s) => s.setContextMenu);
  const openRenameDialog = useTabStore((s) => s.openRenameDialog);
  const setTabHidden = useTabStore((s) => s.setTabHidden);

  const [dragState, setDragState] = useState<DragState>({
    draggingId: null,
    dragOverId: null,
  });
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [hiddenListOpen, setHiddenListOpen] = useState(false);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const dragOverTabRef = useRef<string | null>(null);
  const lastDragPointRef = useRef<{ x: number; y: number } | null>(null);

  const getTabAccentStyle = (tabColor: string | null | undefined, isActive: boolean) =>
    tabColor
      ? {
          borderColor: tabColor,
          color: tabColor,
          boxShadow: isActive ? `inset 0 2px 0 ${tabColor}` : undefined,
          opacity: isActive ? 1 : 0.9,
        }
      : undefined;

  const handleAddTab = () => {
    setIsDialogOpen(true);
  };

  const handleCreateTab = (rootDirectory: string) => {
    if (sessionId) addTab(sessionId, rootDirectory);
    setIsDialogOpen(false);
  };

  const handleTabClick = (tabId: string) => {
    if (sessionId) setActiveTab(sessionId, tabId);
  };

  const handleCloseTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    if (!sessionId) return;
    const tab = useTabStore
      .getState()
      .sessionStates[sessionId]?.tabs.find((entry) => entry.id === tabId);
    if (tab) {
      const confirmed = await confirmTabClose(tab);
      if (!confirmed) return;
      await closeBrowserPanelsForTab(tab);
    }
    closeTab(sessionId, tabId);
  };

  const handleTabContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (sessionId) {
      setContextMenu(sessionId, {
        open: true,
        x: e.clientX,
        y: e.clientY,
        tabId,
      });
    }
  };

  const handleEmptySpaceContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (sessionId) {
      setContextMenu(sessionId, {
        open: true,
        x: e.clientX,
        y: e.clientY,
        tabId: null,
      });
    }
  };

  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    setDragState((prev) => ({ ...prev, draggingId: tabId }));
    lastDragPointRef.current = { x: e.clientX, y: e.clientY };
    e.dataTransfer.effectAllowed = "move";
  };

  const getVisibleReorderIds = (draggingId: string, point: { x: number; y: number }) => {
    const visibleIds = tabs.map((tab) => tab.id);
    const fromIndex = visibleIds.indexOf(draggingId);
    if (fromIndex === -1) return null;

    const tabElements = Array.from(
      tabListRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
    );
    const targetElement = tabElements.find((element) => {
      if (element.dataset.tabId === draggingId) return false;
      const bounds = element.getBoundingClientRect();
      return point.x < bounds.left + bounds.width / 2;
    });
    const targetId = targetElement?.dataset.tabId ?? null;
    const orderWithoutDragged = visibleIds.filter((id) => id !== draggingId);
    const toIndex = targetId ? orderWithoutDragged.indexOf(targetId) : orderWithoutDragged.length;

    if (toIndex < 0) return null;
    orderWithoutDragged.splice(toIndex, 0, draggingId);
    return orderWithoutDragged;
  };

  const mergeVisibleOrderIntoSessionOrder = (visibleIds: string[]) => {
    const visibleQueue = [...visibleIds];
    return attachedTabs
      .map((tab) => {
        if (tab.hidden) return tab.id;
        return visibleQueue.shift() ?? tab.id;
      })
      .filter((id, index, allIds) => allIds.indexOf(id) === index);
  };

  const reorderVisibleTabsAtPoint = (
    sessionId: string,
    draggingId: string,
    point: { x: number; y: number },
  ) => {
    const visibleIds = getVisibleReorderIds(draggingId, point);
    if (!visibleIds) return false;

    const currentVisibleIds = tabs.map((tab) => tab.id);
    const changed = visibleIds.some((id, index) => id !== currentVisibleIds[index]);
    if (!changed) return false;

    reorderTabs(sessionId, mergeVisibleOrderIntoSessionOrder(visibleIds));
    return true;
  };

  useEffect(() => {
    if (!dragState.draggingId) return;

    const updateDragPoint = (event: DragEvent) => {
      if (event.clientX === 0 && event.clientY === 0) return;
      lastDragPointRef.current = { x: event.clientX, y: event.clientY };
    };

    document.addEventListener("dragover", updateDragPoint, true);
    document.addEventListener("drop", updateDragPoint, true);

    return () => {
      document.removeEventListener("dragover", updateDragPoint, true);
      document.removeEventListener("drop", updateDragPoint, true);
    };
  }, [dragState.draggingId]);

  const handleDragEnd = async (e: React.DragEvent) => {
    const draggingId = dragState.draggingId;
    if (!draggingId || !sessionId) {
      setDragState({ draggingId: null, dragOverId: null });
      dragOverTabRef.current = null;
      lastDragPointRef.current = null;
      return;
    }

    const point =
      e.clientX !== 0 || e.clientY !== 0
        ? { x: e.clientX, y: e.clientY }
        : (lastDragPointRef.current ?? { x: e.clientX, y: e.clientY });
    const barBounds = tabBarRef.current?.getBoundingClientRect() ?? null;
    const distanceFromBar = barBounds
      ? Math.max(barBounds.top - point.y, point.y - barBounds.bottom, 0)
      : 0;
    const pulledAwayFromBar = Boolean(barBounds && distanceFromBar > TAB_DETACH_DISTANCE_PX);

    if (pulledAwayFromBar) {
      const tab = attachedTabs.find((entry) => entry.id === draggingId);
      if (tab) {
        detachTab(sessionId, draggingId, tab.detachedWindowBounds ?? null);
        const nextSessionState = useTabStore.getState().sessionStates[sessionId];
        if (nextSessionState) {
          try {
            await savePersistedTabState(sessionId, nextSessionState);
            await waitForOwnerDetachRender();
            await openDetachedTabWindow(
              sessionId,
              tab.id,
              tab.name,
              tab.detachedWindowBounds ?? null,
            );
          } catch (error) {
            console.error("Failed to detach tab:", error);
          }
        }
      }
    } else {
      reorderVisibleTabsAtPoint(sessionId, draggingId, point);
    }
    setDragState({ draggingId: null, dragOverId: null });
    dragOverTabRef.current = null;
    lastDragPointRef.current = null;
  };

  const handleDragOver = (e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    lastDragPointRef.current = { x: e.clientX, y: e.clientY };
    if (dragState.draggingId && dragState.draggingId !== tabId) {
      setDragState((prev) => ({ ...prev, dragOverId: tabId }));
      dragOverTabRef.current = tabId;
    }
  };

  const handleDragLeave = () => {
    setDragState((prev) => ({ ...prev, dragOverId: null }));
    dragOverTabRef.current = null;
  };

  const handleDrop = () => {
    // Reordering happens in handleDragEnd
  };

  const handleSelectHiddenTab = (tabId: string) => {
    if (!sessionId) return;
    setActiveTab(sessionId, tabId);
    setHiddenListOpen(false);
  };

  const handleUnhideTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    if (!sessionId) return;
    setTabHidden(sessionId, tabId, false);
  };

  return (
    <>
      <div
        ref={tabBarRef}
        className="flex h-9 items-center border-b border-zinc-800 bg-zinc-950 px-2"
        onContextMenu={handleEmptySpaceContextMenu}
        onDragOver={(e) => {
          e.preventDefault();
          lastDragPointRef.current = { x: e.clientX, y: e.clientY };
        }}
      >
        {/* Tabs container */}
        <div
          ref={tabListRef}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onWheel={handleHorizontalWheelScroll}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isDragging = dragState.draggingId === tab.id;
            const isDragOver = dragState.dragOverId === tab.id;

            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                draggable
                onDragStart={(e) => handleDragStart(e, tab.id)}
                onDragEnd={(e) => void handleDragEnd(e)}
                onDragOver={(e) => handleDragOver(e, tab.id)}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => handleTabClick(tab.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (sessionId) {
                    openRenameDialog(sessionId, { kind: "tab", tabId: tab.id });
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) handleCloseTab(e, tab.id);
                }}
                onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
                className={`group relative flex min-w-[120px] max-w-[200px] cursor-pointer select-none items-center gap-2 rounded-t-md border border-transparent px-3 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-zinc-800 text-zinc-100"
                    : "bg-zinc-900/50 text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300"
                } ${isDragging ? "opacity-50" : ""} ${isDragOver ? "border-l-2 border-l-zinc-500" : ""} `}
                style={getTabAccentStyle(tab.color, isActive)}
                title={tab.name}
              >
                {isActive && !tab.color ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-[2px] rounded-t-md bg-zinc-300"
                  />
                ) : null}
                {tab.color && isActive ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none h-2.5 w-2.5 rounded-full border border-white/10"
                    style={{ backgroundColor: tab.color }}
                  />
                ) : null}
                {tab.rootDirectoryMissing ? (
                  <span
                    aria-hidden="true"
                    className="inline-flex h-4 min-w-4 animate-pulse items-center justify-center rounded-sm border border-red-900/70 bg-red-950/30 px-1 text-[10px] font-semibold text-red-300"
                    title={`Missing directory: ${tab.rootDirectory}`}
                  >
                    !
                  </span>
                ) : null}
                <span className="flex-1 truncate">{tab.name}</span>
                <button
                  onClick={(e) => void handleCloseTab(e, tab.id)}
                  className="rounded p-0.5 text-zinc-400 opacity-0 transition-all hover:bg-zinc-700 hover:text-zinc-100 group-hover:opacity-100"
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
              className="ml-2 flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              title="Hidden tabs"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-64 border-zinc-800 bg-zinc-950 p-1 text-zinc-100 shadow-xl shadow-black/70"
          >
            {hiddenTabs.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-zinc-500">No hidden tabs</div>
            ) : (
              hiddenTabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                const tabColor = tab.color?.trim() || null;
                return (
                  <div
                    key={tab.id}
                    className="flex min-w-0 items-center gap-1 rounded-sm text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectHiddenTab(tab.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                      title={tab.name}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          tabColor
                            ? "border border-white/10"
                            : isActive
                              ? "bg-zinc-100"
                              : "bg-zinc-600"
                        }`}
                        style={tabColor ? { backgroundColor: tabColor } : undefined}
                      />
                      <span className="truncate">{tab.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleUnhideTab(e, tab.id)}
                      className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                      title="Unhide tab"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </PopoverContent>
        </Popover>

        {/* Add tab button */}
        <button
          onClick={handleAddTab}
          className="ml-1 flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          title="New tab"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <NewTabDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} onCreate={handleCreateTab} />
    </>
  );
};
