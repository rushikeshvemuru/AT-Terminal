import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "./store/useSessionStore";
import { useTabStore } from "./store/useTabStore";
import { HeaderBar } from "./components/HeaderBar";
import { Toolbar } from "./components/Toolbar";
import { SidePanel } from "./components/SidePanel";
import { Workspace } from "./components/Workspace";
import { SessionContent } from "./components/SessionContent";
import { FooterBar } from "./components/FooterBar";
import { TabContextMenu } from "./components/TabContextMenu";
import { PanelContextMenu } from "./components/PanelContextMenu";
import { RenameItemDialog } from "./components/RenameItemDialog";
import { CustomizeTabDialog } from "./components/CustomizeTabDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { GitAuthDialog } from "./components/GitAuthDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ModulePanelPopupLayer } from "./components/ModulePanelPopupLayer";
import { DetachedTabWindowApp } from "./components/DetachedTabWindowApp";
import { useTabPersistence } from "./hooks/useTabPersistence";
import { useDetachedTabOwnerEvents } from "./hooks/useDetachedTabOwnerEvents";
import { usePanelFullscreenHotkey } from "./hooks/usePanelFullscreenHotkey";
import { useTabRootDirectoryValidation } from "./hooks/useTabRootDirectoryValidation";
import { setModuleRegistry, type ModuleRegistrySnapshot } from "./lib/panelRegistry";
import { usePanelFullscreenStore } from "./store/usePanelFullscreenStore";
import "./modules/base";

function isDetachedTabWindow() {
  return (
    new URLSearchParams(window.location.search).has("detachedTab") ||
    window.location.hash === "#detachedTab"
  );
}

function App() {
  const detachedWindow = isDetachedTabWindow();
  useTabPersistence(!detachedWindow);
  useDetachedTabOwnerEvents(!detachedWindow);
  useTabRootDirectoryValidation(!detachedWindow);

  useEffect(() => {
    const loadModules = async () => {
      try {
        await invoke("initialize_modules");
        const registry = await invoke<ModuleRegistrySnapshot>("get_module_registry");
        setModuleRegistry(registry);
      } catch (err) {
        console.error("[modules] Failed to initialize module registry:", err);
      }
    };

    loadModules();
  }, []);
  const navState = useSessionStore((s) => s.navState);
  const activeSessionId = useSessionStore((s) => s.activeSession?.id);
  const isPanelFullscreen = usePanelFullscreenStore((s) => s.isPanelFullscreen);
  const exitPanelFullscreen = usePanelFullscreenStore((s) => s.exitPanelFullscreen);
  const sessionState = useTabStore((s) =>
    activeSessionId ? (s.sessionStates[activeSessionId] ?? null) : null,
  );
  const sidePanelOpen = useTabStore((s) =>
    activeSessionId ? (s.sessionStates[activeSessionId]?.sidePanelOpen ?? true) : true,
  );
  const isTerminal = navState === "TERMINAL";
  const activeTab = sessionState?.tabs.find((tab) => tab.id === sessionState.activeTabId) ?? null;
  const activePanel =
    activeTab?.panels.find((panel) => panel.id === activeTab.activePanelId) ?? null;

  usePanelFullscreenHotkey(isTerminal && activePanel !== null);

  useEffect(() => {
    if (!isPanelFullscreen) {
      return;
    }

    if (!isTerminal) {
      exitPanelFullscreen();
      return;
    }

    if (!activeTab || !activePanel) {
      exitPanelFullscreen();
    }
  }, [activePanel, activeTab, exitPanelFullscreen, isPanelFullscreen, isTerminal]);

  if (detachedWindow) {
    return <DetachedTabWindowApp />;
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* Title bar — fixed height, full width */}
      <HeaderBar />

      {/* Toolbar — fixed height, full width (terminal only) */}
      {isTerminal && !isPanelFullscreen && <Toolbar />}

      {/* Main row — horizontal split, fills remaining height */}
      <div className="flex flex-1 overflow-hidden">
        {isTerminal && sidePanelOpen && !isPanelFullscreen && <SidePanel />}
        {isTerminal ? <Workspace /> : <SessionContent />}
      </div>

      {/* Footer bar — fixed height, full width */}
      {(!isTerminal || !isPanelFullscreen) && <FooterBar />}

      {/* Floating overlays */}
      <TabContextMenu />
      <PanelContextMenu />
      <RenameItemDialog />
      <CustomizeTabDialog />
      <ConfirmDialog />
      <GitAuthDialog />
      <ModulePanelPopupLayer />
    </div>
  );
}

function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default AppWithErrorBoundary;
