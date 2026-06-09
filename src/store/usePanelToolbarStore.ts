import { create } from "zustand";
import type {
  PanelToolbarChangeMessage,
  PanelToolbarClickMessage,
  PanelToolbarItemPatch,
  RuntimePanelToolbarItem,
} from "@/lib/panelRegistry";

type PanelToolbarSender = (message: PanelToolbarClickMessage | PanelToolbarChangeMessage) => void;

interface PanelToolbarRuntimeState {
  ready: boolean;
  runtimeItems: RuntimePanelToolbarItem[] | null;
  itemPatches: Record<string, PanelToolbarItemPatch>;
  sender: PanelToolbarSender | null;
}

interface PanelToolbarState {
  panels: Record<string, PanelToolbarRuntimeState>;
  registerPanelSender: (panelId: string, sender: PanelToolbarSender) => void;
  unregisterPanelSender: (panelId: string) => void;
  setPanelReady: (panelId: string, ready: boolean) => void;
  setToolbarItems: (panelId: string, items: RuntimePanelToolbarItem[]) => void;
  applyItemPatches: (panelId: string, patches: PanelToolbarItemPatch[]) => void;
  resetPanelToolbar: (panelId: string) => void;
  clearPanelToolbar: (panelId: string) => void;
  dispatchToolbarClick: (
    panelId: string,
    itemId: string,
    command: string,
    parentItemId?: string,
  ) => boolean;
  dispatchToolbarChange: (
    panelId: string,
    itemId: string,
    command: string,
    value: string | boolean | number,
  ) => boolean;
}

function createPanelToolbarRuntimeState(): PanelToolbarRuntimeState {
  return {
    ready: false,
    runtimeItems: null,
    itemPatches: {},
    sender: null,
  };
}

export const usePanelToolbarStore = create<PanelToolbarState>((set, get) => ({
  panels: {},

  registerPanelSender: (panelId, sender) => {
    set((state) => {
      const panelState = state.panels[panelId] ?? createPanelToolbarRuntimeState();
      return {
        panels: {
          ...state.panels,
          [panelId]: {
            ...panelState,
            sender,
          },
        },
      };
    });
  },

  unregisterPanelSender: (panelId) => {
    set((state) => {
      const panelState = state.panels[panelId];
      if (!panelState) return state;

      return {
        panels: {
          ...state.panels,
          [panelId]: {
            ...panelState,
            ready: false,
            sender: null,
          },
        },
      };
    });
  },

  setPanelReady: (panelId, ready) => {
    set((state) => {
      const panelState = state.panels[panelId] ?? createPanelToolbarRuntimeState();
      return {
        panels: {
          ...state.panels,
          [panelId]: {
            ...panelState,
            ready,
          },
        },
      };
    });
  },

  setToolbarItems: (panelId, items) => {
    set((state) => {
      const panelState = state.panels[panelId] ?? createPanelToolbarRuntimeState();
      return {
        panels: {
          ...state.panels,
          [panelId]: {
            ...panelState,
            runtimeItems: items,
            itemPatches: {},
          },
        },
      };
    });
  },

  applyItemPatches: (panelId, patches) => {
    if (patches.length === 0) return;

    set((state) => {
      const panelState = state.panels[panelId] ?? createPanelToolbarRuntimeState();
      const itemPatches = { ...panelState.itemPatches };

      for (const patch of patches) {
        itemPatches[patch.id] = {
          ...(itemPatches[patch.id] ?? { id: patch.id }),
          ...patch,
        };
      }

      return {
        panels: {
          ...state.panels,
          [panelId]: {
            ...panelState,
            itemPatches,
          },
        },
      };
    });
  },

  resetPanelToolbar: (panelId) => {
    set((state) => {
      const panelState = state.panels[panelId] ?? createPanelToolbarRuntimeState();
      return {
        panels: {
          ...state.panels,
          [panelId]: {
            ...panelState,
            ready: false,
            runtimeItems: null,
            itemPatches: {},
          },
        },
      };
    });
  },

  clearPanelToolbar: (panelId) => {
    set((state) => {
      if (!(panelId in state.panels)) return state;

      const panels = { ...state.panels };
      delete panels[panelId];
      return { panels };
    });
  },

  dispatchToolbarClick: (panelId, itemId, command, parentItemId) => {
    const sender = get().panels[panelId]?.sender;
    if (!sender) return false;

    sender({
      type: "at.panelToolbar.click",
      panelId,
      itemId,
      command,
      ...(parentItemId ? { parentItemId } : {}),
    });
    return true;
  },

  dispatchToolbarChange: (panelId, itemId, command, value) => {
    const sender = get().panels[panelId]?.sender;
    if (!sender) return false;

    sender({
      type: "at.panelToolbar.change",
      panelId,
      itemId,
      command,
      value,
    });
    return true;
  },
}));
