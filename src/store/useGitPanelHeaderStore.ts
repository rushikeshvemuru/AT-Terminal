import { create } from "zustand";

export type GitHeaderTone = "neutral" | "success" | "danger" | "warning";

interface GitPanelHeaderState {
  visible: boolean;
  rootDirectory: string | null;
  username: string | null;
  tone: GitHeaderTone;
  isRefreshing: boolean;
  onRefresh: (() => void) | null;
}

interface GitPanelHeaderStore extends GitPanelHeaderState {
  setState: (next: Partial<GitPanelHeaderState>) => void;
  reset: () => void;
}

const initialGitPanelHeaderState: GitPanelHeaderState = {
  visible: false,
  rootDirectory: null,
  username: null,
  tone: "neutral",
  isRefreshing: false,
  onRefresh: null,
};

export const useGitPanelHeaderStore = create<GitPanelHeaderStore>((set) => ({
  ...initialGitPanelHeaderState,
  setState: (next) =>
    set((state) => {
      const merged = { ...state, ...next };
      if (
        merged.visible === state.visible &&
        merged.rootDirectory === state.rootDirectory &&
        merged.username === state.username &&
        merged.tone === state.tone &&
        merged.isRefreshing === state.isRefreshing &&
        merged.onRefresh === state.onRefresh
      ) {
        return state;
      }
      return merged;
    }),
  reset: () => set(initialGitPanelHeaderState),
}));
