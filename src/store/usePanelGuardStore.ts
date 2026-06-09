import { create } from "zustand";

export type PanelGuardReason = "close" | "change-type" | "replace-file" | "reload";
export type PanelGuard = (reason: PanelGuardReason) => boolean | Promise<boolean>;

interface PanelGuardState {
  guards: Record<string, PanelGuard>;
  registerGuard: (panelId: string, guard: PanelGuard) => void;
  unregisterGuard: (panelId: string) => void;
  confirmPanelAction: (panelId: string, reason: PanelGuardReason) => Promise<boolean>;
}

export const usePanelGuardStore = create<PanelGuardState>((set, get) => ({
  guards: {},

  registerGuard: (panelId, guard) => {
    set((state) => ({ guards: { ...state.guards, [panelId]: guard } }));
  },

  unregisterGuard: (panelId) => {
    set((state) => {
      const guards = { ...state.guards };
      delete guards[panelId];
      return { guards };
    });
  },

  confirmPanelAction: async (panelId, reason) => {
    const guard = get().guards[panelId];
    if (!guard) return true;
    return guard(reason);
  },
}));
