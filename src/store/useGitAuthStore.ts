import { create } from "zustand";
import type { GitAuthStatus } from "@/types/git";

export interface GitAuthRequest {
  rootDirectory: string;
  status: GitAuthStatus;
  actionLabel: string;
  onOpenTerminal: (command?: string) => void;
  resolve: (ready: boolean) => void;
}

interface GitAuthState {
  request: GitAuthRequest | null;
  requestSetup: (options: Omit<GitAuthRequest, "resolve">) => Promise<boolean>;
  resolve: (ready: boolean) => void;
}

export const useGitAuthStore = create<GitAuthState>((set, get) => ({
  request: null,

  requestSetup: (options) =>
    new Promise<boolean>((resolve) => {
      set({ request: { ...options, resolve } });
    }),

  resolve: (ready) => {
    const request = get().request;
    if (!request) return;
    request.resolve(ready);
    set({ request: null });
  },
}));
