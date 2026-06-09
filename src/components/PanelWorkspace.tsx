import type { Tab, PanelType } from "@/store/useTabStore";
import { useTabStore } from "@/store/useTabStore";
import { useActiveSessionId } from "@/hooks/useActiveSessionTabState";
import {
  getNativePanelComponent,
  getPanelColor,
  getPanelMetadata,
  useModuleRegistry,
} from "@/lib/panelRegistry";
import type { PanelState } from "@/lib/panelRegistry";
import { ModulePanelHost } from "@/components/panels/ModulePanelHost";
import { FallbackPanel } from "@/components/panels/FallbackPanel";
import { usePanelGuardStore } from "@/store/usePanelGuardStore";
import { closeBrowserPanelForPanel } from "@/lib/browserPanelLifecycle";
import { cn } from "@/lib/utils";

interface PanelWorkspaceProps {
  tab: Tab;
}

export const PanelWorkspace = ({ tab }: PanelWorkspaceProps) => {
  useModuleRegistry();
  const sessionId = useActiveSessionId();
  const updatePanelType = useTabStore((state) => state.updatePanelType);
  const updatePanelState = useTabStore((state) => state.updatePanelState);
  const confirmPanelAction = usePanelGuardStore((s) => s.confirmPanelAction);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
      {tab.panels.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center bg-black text-xs text-zinc-500">
          No panels
        </div>
      ) : (
        tab.panels.map((panel) => {
          const isActive = panel.id === tab.activePanelId;

          const handleChangeType = async (type: PanelType) => {
            if (sessionId) {
              const confirmed = await confirmPanelAction(panel.id, "change-type");
              if (confirmed) {
                if (panel.type !== type) {
                  await closeBrowserPanelForPanel(panel);
                }
                updatePanelType(sessionId, tab.id, panel.id, type);
              }
            }
          };

          const handlePanelStateChange = (panelState: PanelState) => {
            if (sessionId) updatePanelState(sessionId, tab.id, panel.id, panelState);
          };

          const panelType = getPanelMetadata(panel.type);
          const panelColor = getPanelColor(panel.type);
          const NativePanel = getNativePanelComponent(panel.type);

          return (
            <div
              key={panel.id}
              className={cn(
                "absolute inset-0 flex flex-col border bg-black",
                isActive ? "pointer-events-auto visible z-10" : "pointer-events-none invisible z-0",
              )}
              style={{ borderColor: panelColor }}
              aria-hidden={!isActive}
            >
              {NativePanel ? (
                <NativePanel
                  panel={panel}
                  rootDirectory={tab.rootDirectory}
                  isActive={isActive}
                  onChangeType={handleChangeType}
                  onPanelStateChange={handlePanelStateChange}
                />
              ) : panelType ? (
                <ModulePanelHost
                  panel={panel}
                  panelType={panelType}
                  rootDirectory={tab.rootDirectory}
                  isActive={isActive}
                  onChangeType={handleChangeType}
                  onPanelStateChange={handlePanelStateChange}
                />
              ) : (
                <FallbackPanel
                  panel={panel}
                  rootDirectory={tab.rootDirectory}
                  onChangeType={handleChangeType}
                />
              )}
            </div>
          );
        })
      )}
    </div>
  );
};
