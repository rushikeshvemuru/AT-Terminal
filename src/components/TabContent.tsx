import { useTabStore } from "@/store/useTabStore";
import { useActiveSessionId } from "@/hooks/useActiveSessionTabState";
import { usePanelFullscreenStore } from "@/store/usePanelFullscreenStore";
import { PanelBar } from "./PanelBar";
import { PanelWorkspace } from "./PanelWorkspace";
import { cn } from "@/lib/utils";

export const TabContent = () => {
  const sessionId = useActiveSessionId();
  const sessionState = useTabStore((s) =>
    sessionId ? (s.sessionStates[sessionId] ?? null) : null,
  );
  const isPanelFullscreen = usePanelFullscreenStore((s) => s.isPanelFullscreen);

  const tabs = (sessionState?.tabs ?? []).filter((tab) => !tab.detached);
  const activeTabId = sessionState?.activeTabId ?? null;

  if (tabs.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-zinc-950 text-zinc-400">
        <p className="text-sm">No tabs open</p>
        <p className="mt-2 text-xs text-zinc-500">Click the + button to create a new tab</p>
      </div>
    );
  }

  if (!activeTabId) {
    return (
      <div className="flex h-full w-full flex-col bg-zinc-950 text-zinc-400">
        <div className="flex-1" />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-black font-mono text-zinc-100">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={cn(
              "absolute inset-0 flex flex-col",
              isPanelFullscreen ? "p-0" : "p-4",
              isActive ? "pointer-events-auto visible z-10" : "pointer-events-none invisible z-0",
            )}
            aria-hidden={!isActive}
          >
            {!isPanelFullscreen && (
              <>
                <PanelBar tab={tab} />
                <div className="h-1" />
              </>
            )}
            <PanelWorkspace tab={tab} />
          </div>
        );
      })}
    </div>
  );
};
