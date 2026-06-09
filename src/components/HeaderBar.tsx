import { Minimize2 } from "lucide-react";
import { usePanelFullscreenStore } from "@/store/usePanelFullscreenStore";
import { useSessionStore } from "@/store/useSessionStore";
import { SessionSwitcher } from "./SessionSwitcher";
import WindowControls from "./WindowControls";

export const HeaderBar = () => {
  const { navState } = useSessionStore();
  const isPanelFullscreen = usePanelFullscreenStore((s) => s.isPanelFullscreen);
  const exitPanelFullscreen = usePanelFullscreenStore((s) => s.exitPanelFullscreen);

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 select-none items-center border-b border-zinc-800/80 bg-zinc-950 px-4"
    >
      <div data-tauri-drag-region className="flex flex-1 items-center">
        {navState === "TERMINAL" ? (
          <SessionSwitcher />
        ) : (
          <span className="text-sm font-medium text-zinc-100">AT-Terminal</span>
        )}
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
  );
};
