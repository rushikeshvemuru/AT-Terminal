import { create } from "zustand";

interface FileExplorerState {
  showHidden: boolean;
  searchFilter: string;
  renamingPath: string | null;
  creatingInPath: string | null;
  creatingType: "file" | "directory" | null;
  toggleShowHidden: () => void;
  setSearchFilter: (filter: string) => void;
  startRename: (path: string) => void;
  cancelRename: () => void;
  startCreating: (parentPath: string, type: "file" | "directory") => void;
  cancelCreating: () => void;
  clearFilter: () => void;
}

export const useFileExplorerStore = create<FileExplorerState>((set) => ({
  showHidden: false,
  searchFilter: "",
  renamingPath: null,
  creatingInPath: null,
  creatingType: null,

  toggleShowHidden: () => set((state) => ({ showHidden: !state.showHidden })),
  setSearchFilter: (filter) => set({ searchFilter: filter }),
  startRename: (path) => set({ renamingPath: path }),
  cancelRename: () => set({ renamingPath: null }),
  startCreating: (parentPath, type) => set({ creatingInPath: parentPath, creatingType: type }),
  cancelCreating: () => set({ creatingInPath: null, creatingType: null }),
  clearFilter: () => set({ searchFilter: "" }),
}));
