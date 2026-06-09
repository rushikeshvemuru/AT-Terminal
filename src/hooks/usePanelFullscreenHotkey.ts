import { useEffect } from "react";
import { isEditableTarget, isPanelFullscreenHotkey } from "@/lib/panelFullscreenHotkey";
import { usePanelFullscreenStore } from "@/store/usePanelFullscreenStore";

export function usePanelFullscreenHotkey(enabled: boolean) {
  const togglePanelFullscreen = usePanelFullscreenStore((s) => s.togglePanelFullscreen);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isPanelFullscreenHotkey(event)) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      event.preventDefault();
      togglePanelFullscreen();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, togglePanelFullscreen]);
}
