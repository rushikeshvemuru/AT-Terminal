import { create } from "zustand";

export interface PanelPopupRuntimeState {
  popupId: string;
  sourcePanelId: string;
  title: string;
  src: string;
  width: number;
  height: number;
  openedAt: number;
}

interface OpenPanelPopupInput {
  popupId?: string;
  sourcePanelId: string;
  title: string;
  src: string;
  width: number;
  height: number;
}

interface PanelPopupState {
  popups: Record<string, PanelPopupRuntimeState>;
  openPopup: (input: OpenPanelPopupInput) => string;
  closePopupForPanel: (sourcePanelId: string) => void;
  closePopupById: (popupId: string) => void;
  closeAllPopups: () => void;
}

let popupCounter = 0;
let openedAtCounter = 0;

function nextPopupId(sourcePanelId: string): string {
  popupCounter += 1;
  return `${sourcePanelId}-popup-${Date.now()}-${popupCounter}`;
}

export const usePanelPopupStore = create<PanelPopupState>((set) => ({
  popups: {},

  openPopup: ({ popupId, sourcePanelId, title, src, width, height }) => {
    const resolvedPopupId = popupId ?? nextPopupId(sourcePanelId);
    openedAtCounter += 1;

    set((state) => ({
      popups: {
        ...state.popups,
        [sourcePanelId]: {
          popupId: resolvedPopupId,
          sourcePanelId,
          title,
          src,
          width,
          height,
          openedAt: openedAtCounter,
        },
      },
    }));

    return resolvedPopupId;
  },

  closePopupForPanel: (sourcePanelId) => {
    set((state) => {
      if (!(sourcePanelId in state.popups)) {
        return state;
      }

      const popups = { ...state.popups };
      delete popups[sourcePanelId];
      return { popups };
    });
  },

  closePopupById: (popupId) => {
    set((state) => {
      const entry = Object.entries(state.popups).find(([, popup]) => popup.popupId === popupId);
      if (!entry) {
        return state;
      }

      const [sourcePanelId] = entry;
      const popups = { ...state.popups };
      delete popups[sourcePanelId];
      return { popups };
    });
  },

  closeAllPopups: () => {
    set({ popups: {} });
  },
}));
