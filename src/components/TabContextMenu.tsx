import { useState } from "react";
import { useTabStore } from "@/store/useTabStore";
import { useActiveSessionId } from "@/hooks/useActiveSessionTabState";
import { closeBrowserPanelsForTab, closeBrowserPanelsForTabs } from "@/lib/browserPanelLifecycle";
import { FloatingContextMenu } from "@/components/ui/floating-context-menu";
import { confirmTabClose, confirmTabsClose } from "@/lib/tabClose";
import {
  closeDetachedTabWindow,
  openDetachedTabWindow,
  waitForOwnerDetachRender,
} from "@/lib/detachedTabs";
import { savePersistedTabState } from "@/lib/tabPersistence";
import { NewTabDialog } from "./NewTabDialog";

const menuItemClassName =
  "w-full px-4 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none";

export const TabContextMenu = () => {
  const sessionId = useActiveSessionId();
  const sessionState = useTabStore((s) =>
    sessionId ? (s.sessionStates[sessionId] ?? null) : null,
  );
  const {
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    detachTab,
    setContextMenu,
    addTab,
    openRenameDialog,
    openCustomizeTabDialog,
    setTabHidden,
  } = useTabStore();

  const contextMenu = sessionState?.contextMenu ?? { open: false, x: 0, y: 0, tabId: null };
  const tabs = sessionState?.tabs ?? [];

  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleCreateTab = (rootDirectory: string) => {
    if (sessionId) {
      addTab(sessionId, rootDirectory);
    }
    setIsDialogOpen(false);
  };

  if (!contextMenu.open || !sessionId) {
    return (
      <NewTabDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} onCreate={handleCreateTab} />
    );
  }

  const { x, y, tabId } = contextMenu;
  const closeMenu = () => setContextMenu(sessionId, { open: false });

  // Handle "New Tab" option from empty space context menu
  const handleNewTab = () => {
    closeMenu();
    setIsDialogOpen(true);
  };

  const handleRenameTab = () => {
    if (!sessionId || !tabId) return;
    openRenameDialog(sessionId, { kind: "tab", tabId });
    closeMenu();
  };

  const handleCustomizeTab = () => {
    if (!sessionId || !tabId) return;
    openCustomizeTabDialog(sessionId, tabId);
    closeMenu();
  };

  const handleToggleTabHidden = () => {
    if (!sessionId || !tabId) return;
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) return;
    setTabHidden(sessionId, tabId, !tab.hidden);
    closeMenu();
  };

  const handleDetachTab = async () => {
    if (!sessionId || !tabId) return;
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab || tab.detached) return;

    detachTab(sessionId, tabId, tab.detachedWindowBounds ?? null);
    const nextSessionState = useTabStore.getState().sessionStates[sessionId];
    closeMenu();

    if (!nextSessionState) return;

    try {
      await savePersistedTabState(sessionId, nextSessionState);
      await waitForOwnerDetachRender();
      await openDetachedTabWindow(sessionId, tab.id, tab.name, tab.detachedWindowBounds ?? null);
    } catch (error) {
      console.error("Failed to detach tab:", error);
    }
  };

  const handleCloseTab = async () => {
    if (!sessionId || !tabId) return;
    const tab = tabs.find((entry) => entry.id === tabId);
    if (tab) {
      const confirmed = await confirmTabClose(tab);
      if (!confirmed) {
        closeMenu();
        return;
      }
      await closeBrowserPanelsForTab(tab);
    }
    closeTab(sessionId, tabId);
    closeMenu();
  };

  const handleCloseOtherTabs = async () => {
    if (!sessionId || !tabId) return;
    const tabsToClose = tabs.filter((entry) => entry.id !== tabId);
    const confirmed = await confirmTabsClose(tabsToClose);
    if (!confirmed) {
      closeMenu();
      return;
    }
    await closeBrowserPanelsForTabs(tabsToClose);
    await Promise.all(
      tabsToClose
        .filter((entry) => entry.detached)
        .map((entry) => closeDetachedTabWindow(sessionId, entry.id).catch(console.error)),
    );
    closeOtherTabs(sessionId, tabId);
    closeMenu();
  };

  const handleCloseTabsToRight = async () => {
    if (!sessionId || !tabId) return;
    const currentIndex = tabs.findIndex((entry) => entry.id === tabId);
    if (currentIndex === -1) return;
    const tabsToClose = tabs.slice(currentIndex + 1);
    const confirmed = await confirmTabsClose(tabsToClose);
    if (!confirmed) {
      closeMenu();
      return;
    }
    await closeBrowserPanelsForTabs(tabsToClose);
    await Promise.all(
      tabsToClose
        .filter((entry) => entry.detached)
        .map((entry) => closeDetachedTabWindow(sessionId, entry.id).catch(console.error)),
    );
    closeTabsToRight(sessionId, tabId);
    closeMenu();
  };

  // If tabId is null, show empty space context menu (New Tab option)
  if (!tabId) {
    return (
      <>
        <FloatingContextMenu x={x} y={y} onClose={closeMenu}>
          <button
            type="button"
            role="menuitem"
            onClick={handleNewTab}
            className={menuItemClassName}
          >
            New Tab
          </button>
        </FloatingContextMenu>
        <NewTabDialog
          open={isDialogOpen}
          onOpenChange={setIsDialogOpen}
          onCreate={handleCreateTab}
        />
      </>
    );
  }

  const tabIndex = tabs.findIndex((t) => t.id === tabId);
  const isLastTab = tabIndex === tabs.length - 1;
  const tab = tabs.find((entry) => entry.id === tabId);
  const isHidden = Boolean(tab?.hidden);

  return (
    <FloatingContextMenu x={x} y={y} onClose={closeMenu}>
      <button
        type="button"
        role="menuitem"
        onClick={handleCustomizeTab}
        className={menuItemClassName}
      >
        Customise
      </button>
      <button type="button" role="menuitem" onClick={handleRenameTab} className={menuItemClassName}>
        Rename Tab
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={handleToggleTabHidden}
        className={menuItemClassName}
      >
        {isHidden ? "Unhide Tab" : "Hide Tab"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => void handleDetachTab()}
        className={menuItemClassName}
      >
        Detach Tab
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => void handleCloseTab()}
        className={menuItemClassName}
      >
        Close Tab
      </button>
      {tabs.length > 1 && (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCloseOtherTabs()}
            className={menuItemClassName}
          >
            Close Other Tabs
          </button>
          {!isLastTab && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleCloseTabsToRight()}
              className={menuItemClassName}
            >
              Close Tabs to the Right
            </button>
          )}
        </>
      )}
    </FloatingContextMenu>
  );
};
