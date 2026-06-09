import { Palette } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveSessionId } from "@/hooks/useActiveSessionTabState";
import { useTabStore } from "@/store/useTabStore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const TAB_COLOR_PRESETS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
] as const;

function normalizeTabColor(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : null;
}

export const CustomizeTabDialog = () => {
  const sessionId = useActiveSessionId();
  const sessionState = useTabStore((s) =>
    sessionId ? (s.sessionStates[sessionId] ?? null) : null,
  );
  const { closeCustomizeTabDialog, customizeTab } = useTabStore();

  const customizeDialog = sessionState?.customizeTabDialog ?? { open: false, tabId: null };

  const handleOpenChange = (open: boolean) => {
    if (!open && sessionId) {
      closeCustomizeTabDialog(sessionId);
    }
  };

  if (!sessionId || !sessionState || !customizeDialog.open || !customizeDialog.tabId) {
    return null;
  }

  const tab = sessionState.tabs.find((entry) => entry.id === customizeDialog.tabId) ?? null;
  if (!tab) {
    return null;
  }

  return (
    <Dialog open={customizeDialog.open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>Customize Tab</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Choose a label and color for this tab. These settings are saved with the session in
            `.atterm`.
          </DialogDescription>
        </DialogHeader>
        <CustomizeTabForm
          key={tab.id}
          initialName={tab.name}
          initialColor={normalizeTabColor(tab.color ?? "")}
          onCancel={() => closeCustomizeTabDialog(sessionId)}
          onSubmit={(name, color) => {
            customizeTab(sessionId, tab.id, { name, color });
            closeCustomizeTabDialog(sessionId);
          }}
        />
      </DialogContent>
    </Dialog>
  );
};

function CustomizeTabForm({
  initialName,
  initialColor,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  initialColor: string | null;
  onCancel: () => void;
  onSubmit: (name: string, color: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<string | null>(initialColor);
  const [customColorInput, setCustomColorInput] = useState(initialColor ?? "");

  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const normalizedCustomColor = useMemo(
    () => normalizeTabColor(customColorInput) ?? color ?? null,
    [color, customColorInput],
  );

  const submit = () => {
    const nextName = name.trim();
    if (!nextName) return;
    onSubmit(nextName, normalizeTabColor(customColorInput) ?? color ?? null);
  };

  return (
    <>
      <div className="space-y-5 py-2">
        <div className="space-y-2">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Name
          </label>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
            placeholder="Tab name"
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Color
            </label>
            <button
              type="button"
              onClick={() => {
                setColor(null);
                setCustomColorInput("");
              }}
              className="text-xs text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Clear
            </button>
          </div>

          <div className="grid grid-cols-5 gap-2">
            {TAB_COLOR_PRESETS.map((preset) => {
              const isSelected = preset === color;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setColor(preset);
                    setCustomColorInput(preset);
                  }}
                  className={`h-9 rounded-md border transition-transform hover:scale-[1.03] ${
                    isSelected ? "border-zinc-100" : "border-zinc-700"
                  }`}
                  style={{ backgroundColor: preset }}
                  aria-label={`Select ${preset} tab color`}
                />
              );
            })}
          </div>

          <div className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
            <button
              type="button"
              onClick={() => colorInputRef.current?.click()}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-200 transition-colors hover:bg-zinc-800"
              aria-label="Pick custom tab color"
            >
              <Palette className="h-4 w-4" />
            </button>
            <input
              ref={colorInputRef}
              type="color"
              value={normalizedCustomColor ?? "#71717a"}
              onChange={(e) => {
                setColor(e.target.value);
                setCustomColorInput(e.target.value);
              }}
              className="sr-only"
              aria-hidden="true"
              tabIndex={-1}
            />
            <input
              value={customColorInput}
              onChange={(e) => {
                setCustomColorInput(e.target.value);
                const normalized = normalizeTabColor(e.target.value);
                if (normalized) {
                  setColor(normalized);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              className="h-9 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              placeholder="#3b82f6"
            />
            <div className="flex items-center gap-2">
              <span
                className="h-5 w-5 rounded-full border border-white/15"
                style={{ backgroundColor: normalizedCustomColor ?? "#27272a" }}
              />
            </div>
          </div>
        </div>
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
          onClick={submit}
          disabled={!name.trim()}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </DialogFooter>
    </>
  );
}
