import { useEffect, useRef, useState } from "react";
import { useTabStore } from "@/store/useTabStore";
import { useActiveSessionId } from "@/hooks/useActiveSessionTabState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const RenameItemDialog = () => {
  const sessionId = useActiveSessionId();
  const sessionState = useTabStore((s) =>
    sessionId ? (s.sessionStates[sessionId] ?? null) : null,
  );
  const { closeRenameDialog, renameTab, renamePanel } = useTabStore();

  const renameDialog = sessionState?.renameDialog ?? { open: false, target: null };

  const handleOpenChange = (open: boolean) => {
    if (!open && sessionId) {
      closeRenameDialog(sessionId);
    }
  };

  const handleCancel = () => {
    if (sessionId) {
      closeRenameDialog(sessionId);
    }
  };

  if (!sessionId || !sessionState || !renameDialog.open || !renameDialog.target) {
    return null;
  }

  const target = renameDialog.target;
  const isTab = target.kind === "tab";
  const currentName = isTab
    ? sessionState.tabs.find((tab) => tab.id === target.tabId)?.name
    : sessionState.tabs
        .find((tab) => tab.id === target.tabId)
        ?.panels.find((panel) => panel.id === target.panelId)?.name;

  const title = isTab ? "Rename Tab" : "Rename Panel";
  const description = isTab
    ? "Update the tab label without changing its identity."
    : "Update the panel label without changing its identity.";

  return (
    <Dialog open={renameDialog.open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-sm">
        <DialogHeader className="text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-zinc-400">{description}</DialogDescription>
        </DialogHeader>
        <RenameItemForm
          key={`${target.kind}:${target.kind === "tab" ? target.tabId : `${target.tabId}:${target.panelId}`}`}
          initialValue={currentName ?? ""}
          onSubmit={(nextName) => {
            if (!sessionId || !renameDialog.target) return;
            if (renameDialog.target.kind === "tab") {
              renameTab(sessionId, renameDialog.target.tabId, nextName);
            } else {
              renamePanel(
                sessionId,
                renameDialog.target.tabId,
                renameDialog.target.panelId,
                nextName,
              );
            }
            closeRenameDialog(sessionId);
          }}
          onCancel={handleCancel}
        />
      </DialogContent>
    </Dialog>
  );
};

function RenameItemForm({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <div className="space-y-2 py-2">
        <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Name
        </label>
        <input
          id="rename-item-input"
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit(value.trim());
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            const nextName = value.trim();
            if (!nextName) {
              onCancel();
              return;
            }
            onSubmit(nextName);
          }}
          className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          placeholder={initialValue || "Untitled"}
        />
      </div>
      <DialogFooter className="gap-2">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const nextName = value.trim();
            if (nextName) onSubmit(nextName);
          }}
          disabled={!value.trim()}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </DialogFooter>
    </>
  );
}
