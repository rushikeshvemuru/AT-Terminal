import { useTabStore, type PanelType } from "@/store/useTabStore";
import { useActiveSessionId, useActiveSessionTabState } from "@/hooks/useActiveSessionTabState";
import { useCreatablePanelTypes } from "@/lib/panelRegistry";
import { closeBrowserPanelForPanel } from "@/lib/browserPanelLifecycle";
import { FloatingContextMenu } from "@/components/ui/floating-context-menu";

const menuItemClassName =
  "w-full px-4 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none";

export const PanelContextMenu = () => {
  const sessionId = useActiveSessionId();
  const sessionState = useActiveSessionTabState();
  const { setPanelContextMenu, addPanel, openRenameDialog, removePanel, setPanelHidden } =
    useTabStore();
  const panelTypeEntries = useCreatablePanelTypes();

  const contextMenu = useTabStore((s) =>
    sessionId ? s.sessionStates[sessionId]?.panelContextMenu : undefined,
  );

  if (!contextMenu?.open || !sessionId || !sessionState) {
    return null;
  }

  const { x, y } = contextMenu;
  const activeTabId = sessionState.activeTabId;
  const activeTab = sessionState.tabs.find((t) => t.id === activeTabId);
  const panelId = contextMenu.panelId;

  if (!activeTab) return null;

  const closeMenu = () => setPanelContextMenu(sessionId, { open: false });

  const handleAddPanel = (type: PanelType) => {
    if (sessionId) {
      addPanel(sessionId, activeTab.id, type);
      closeMenu();
    }
  };

  const handleRenamePanel = () => {
    if (!sessionId || !panelId) return;
    openRenameDialog(sessionId, { kind: "panel", tabId: activeTab.id, panelId });
    closeMenu();
  };

  const handleTogglePanelHidden = () => {
    if (!sessionId || !panelId) return;
    const panel = activeTab.panels.find((entry) => entry.id === panelId);
    if (!panel) return;
    setPanelHidden(sessionId, activeTab.id, panelId, !panel.hidden);
    closeMenu();
  };

  const handleClosePanel = async () => {
    if (!sessionId || !panelId) return;
    const panel = activeTab.panels.find((entry) => entry.id === panelId);
    if (panel) {
      await closeBrowserPanelForPanel(panel);
    }
    removePanel(sessionId, activeTab.id, panelId);
    closeMenu();
  };

  if (panelId) {
    const panel = activeTab.panels.find((entry) => entry.id === panelId);
    const isHidden = Boolean(panel?.hidden);

    return (
      <FloatingContextMenu x={x} y={y} onClose={closeMenu}>
        <button
          type="button"
          role="menuitem"
          onClick={handleRenamePanel}
          className={menuItemClassName}
        >
          Rename Panel
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={handleTogglePanelHidden}
          className={menuItemClassName}
        >
          {isHidden ? "Unhide Panel" : "Hide Panel"}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleClosePanel()}
          className={menuItemClassName}
        >
          Close Panel
        </button>
      </FloatingContextMenu>
    );
  }

  return (
    <FloatingContextMenu x={x} y={y} onClose={closeMenu}>
      {panelTypeEntries.length === 0 ? (
        <div className="px-4 py-2 text-sm text-zinc-500">No modules available</div>
      ) : (
        panelTypeEntries.map((entry) => (
          <button
            type="button"
            role="menuitem"
            key={entry.type}
            onClick={() => handleAddPanel(entry.type as PanelType)}
            className={menuItemClassName}
          >
            {entry.displayName}
          </button>
        ))
      )}
    </FloatingContextMenu>
  );
};
