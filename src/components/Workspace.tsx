import { usePanelFullscreenStore } from "@/store/usePanelFullscreenStore";
import { TabBar } from "./TabBar";
import { TabContent } from "./TabContent";

export const Workspace = () => {
  const isPanelFullscreen = usePanelFullscreenStore((s) => s.isPanelFullscreen);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {!isPanelFullscreen && <TabBar />}
      <div className="flex-1 overflow-hidden">
        <TabContent />
      </div>
    </div>
  );
};
