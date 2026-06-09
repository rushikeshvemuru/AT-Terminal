import { create } from "zustand";

interface PanelFullscreenState {
  isPanelFullscreen: boolean;
  togglePanelFullscreen: () => void;
  exitPanelFullscreen: () => void;
}

export const usePanelFullscreenStore = create<PanelFullscreenState>((set) => ({
  isPanelFullscreen: false,
  togglePanelFullscreen: () => set((state) => ({ isPanelFullscreen: !state.isPanelFullscreen })),
  exitPanelFullscreen: () => set({ isPanelFullscreen: false }),
}));
