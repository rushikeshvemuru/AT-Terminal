import { create } from "zustand";

interface ConfirmationRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "warning";
  destructive?: boolean;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmationState {
  request: ConfirmationRequest | null;
  confirm: (options: Omit<ConfirmationRequest, "resolve">) => Promise<boolean>;
  resolve: (confirmed: boolean) => void;
}

export const useConfirmationStore = create<ConfirmationState>((set, get) => ({
  request: null,

  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      set({ request: { ...options, resolve } });
    }),

  resolve: (confirmed) => {
    const request = get().request;
    if (!request) return;
    request.resolve(confirmed);
    set({ request: null });
  },
}));
