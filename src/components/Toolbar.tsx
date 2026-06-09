import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import {
  ChevronDown,
  Loader2,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
} from "lucide-react";
import { ModuleToolbarIcon } from "@/components/ModuleToolbarIcon";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useActivePanel,
  useActiveSessionId,
  useSidePanelOpen,
} from "@/hooks/useActiveSessionTabState";
import {
  getNativePanelComponent,
  getPanelMetadata,
  useModuleRegistry,
  type PanelToolbarItemPatch,
  type RuntimePanelToolbarNumberItem,
  type RuntimePanelToolbarItem,
  type RuntimePanelToolbarSliderItem,
  type RuntimePanelToolbarTextItem,
} from "@/lib/panelRegistry";
import { resolvePanelToolbarIconSource } from "@/lib/panelToolbarIcon";
import { usePanelFullscreenStore } from "@/store/usePanelFullscreenStore";
import { usePanelToolbarStore } from "@/store/usePanelToolbarStore";
import { useTabStore } from "@/store/useTabStore";

interface ToolbarProps {
  showSidePanelToggle?: boolean;
  leading?: ReactNode;
}

export const Toolbar = ({ showSidePanelToggle = true, leading }: ToolbarProps) => {
  useModuleRegistry();
  const [searchOpen, setSearchOpen] = useState(false);
  const sessionId = useActiveSessionId();
  const sidePanelOpen = useSidePanelOpen();
  const isPanelFullscreen = usePanelFullscreenStore((s) => s.isPanelFullscreen);
  const togglePanelFullscreen = usePanelFullscreenStore((s) => s.togglePanelFullscreen);
  const toggleSidePanel = useTabStore((s) => s.toggleSidePanel);
  const dispatchToolbarClick = usePanelToolbarStore((s) => s.dispatchToolbarClick);
  const dispatchToolbarChange = usePanelToolbarStore((s) => s.dispatchToolbarChange);
  const activePanel = useActivePanel();
  const activePanelType = activePanel ? getPanelMetadata(activePanel.type) : undefined;
  const activePanelRuntime = usePanelToolbarStore((s) =>
    activePanel ? s.panels[activePanel.id] : undefined,
  );
  const isModuleToolbarPanel =
    activePanel !== null &&
    activePanelType !== undefined &&
    getNativePanelComponent(activePanel.type) === undefined;
  const toolbarItems =
    isModuleToolbarPanel && activePanelType?.panelToolbar
      ? (activePanelRuntime?.runtimeItems ?? activePanelType.panelToolbar.items)
          .map((item) => {
            const patch = activePanelRuntime?.itemPatches[item.id];
            const effectiveItem = applyToolbarPatch(item, patch);
            return {
              ...effectiveItem,
              icon: resolvePanelToolbarIconSource(activePanelType, effectiveItem.iconPath),
            };
          })
          .filter((item) => item.visible)
      : isModuleToolbarPanel && activePanelRuntime?.runtimeItems
        ? activePanelRuntime.runtimeItems
            .map((item) => {
              const patch = activePanelRuntime.itemPatches[item.id];
              const effectiveItem = applyToolbarPatch(item, patch);
              return {
                ...effectiveItem,
                icon: activePanelType
                  ? resolvePanelToolbarIconSource(activePanelType, effectiveItem.iconPath)
                  : null,
              };
            })
            .filter((item) => item.visible)
        : [];
  const toolbarReady = activePanelRuntime?.ready ?? false;
  const toolbarVisible = toolbarItems.length > 0;
  const SidePanelIcon = sidePanelOpen ? PanelLeftClose : PanelLeftOpen;
  const FullscreenIcon = isPanelFullscreen ? Minimize2 : Maximize2;
  const canTogglePanelFullscreen = activePanel !== null;

  return (
    <div className="flex h-9 items-center border-y border-white bg-zinc-950 px-2">
      {showSidePanelToggle && (
        <>
          <button
            onClick={() => {
              if (sessionId) toggleSidePanel(sessionId);
            }}
            className={`flex h-7 w-9 items-center justify-center rounded-md transition-colors ${
              sidePanelOpen ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800"
            }`}
            title="Toggle side panel"
          >
            <SidePanelIcon className="h-4 w-4" />
          </button>

          <div className="mx-2 h-5 w-px shrink-0 bg-zinc-700" />
        </>
      )}

      {leading}

      {toolbarVisible && activePanel && (
        <div className="flex min-w-0 items-center">
          <div className="flex items-center gap-1">
            {toolbarItems.map((item) => {
              const disabled = !toolbarReady || item.disabled;
              const accent = item.color.trim();
              const style: CSSProperties | undefined = accent
                ? ({
                    color: accent,
                    backgroundColor: disabled ? undefined : `${accent}14`,
                  } satisfies CSSProperties)
                : undefined;

              if (item.kind === "separator") {
                return <div key={item.id} className="mx-1 h-5 w-px shrink-0 bg-zinc-700" />;
              }

              if (item.kind === "spacer") {
                return <div key={item.id} className="w-3 shrink-0" />;
              }

              if (item.kind === "label") {
                return (
                  <span
                    key={item.id}
                    title={item.tooltip || item.text}
                    className="max-w-40 truncate px-2 text-xs font-medium text-zinc-400"
                    style={accent ? ({ color: accent } satisfies CSSProperties) : undefined}
                  >
                    {item.text}
                  </span>
                );
              }

              if (item.kind === "select") {
                return (
                  <select
                    key={item.id}
                    disabled={disabled}
                    value={item.value}
                    onChange={(event) => {
                      dispatchToolbarChange(
                        activePanel.id,
                        item.id,
                        item.command,
                        event.target.value,
                      );
                    }}
                    title={item.tooltip || item.text || item.command}
                    className={cn(
                      "h-7 max-w-44 rounded-md border border-zinc-800 bg-zinc-900/90 px-2 text-xs font-medium text-zinc-200 outline-none transition-colors focus:border-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-70",
                      disabled ? "bg-zinc-900/70" : "hover:bg-zinc-800/90",
                    )}
                    style={style}
                  >
                    {item.placeholder && (
                      <option value="" disabled>
                        {item.placeholder}
                      </option>
                    )}
                    {item.options.map((option) => (
                      <option key={option.value} value={option.value} disabled={option.disabled}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                );
              }

              if (item.kind === "text") {
                return (
                  <ToolbarTextInput
                    key={`${item.id}:${item.value}`}
                    item={item}
                    disabled={disabled}
                    style={style}
                    onValueChange={(value) => {
                      dispatchToolbarChange(activePanel.id, item.id, item.command, value);
                    }}
                  />
                );
              }

              if (item.kind === "toggle") {
                if (item.icon && !item.text) {
                  const toggleStyle: CSSProperties | undefined =
                    accent || item.checked
                      ? ({
                          color: accent || undefined,
                          backgroundColor: disabled
                            ? undefined
                            : accent
                              ? `${accent}14`
                              : item.checked
                                ? "rgb(63 63 70 / 0.9)"
                                : undefined,
                        } satisfies CSSProperties)
                      : undefined;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={disabled}
                      aria-pressed={item.checked}
                      onClick={() => {
                        dispatchToolbarChange(activePanel.id, item.id, item.command, !item.checked);
                      }}
                      title={item.tooltip || item.text || item.command}
                      className={cn(
                        "flex h-7 w-7 appearance-none items-center justify-center rounded-full border-0 shadow-none outline-none ring-0 transition-colors focus:outline-none focus-visible:outline-none focus-visible:ring-0",
                        disabled
                          ? "cursor-not-allowed bg-zinc-900/70 text-zinc-600 opacity-70"
                          : item.checked
                            ? "bg-zinc-700 text-zinc-100 hover:bg-zinc-600"
                            : "bg-zinc-900/90 text-zinc-200 hover:bg-zinc-800/90",
                      )}
                      style={toggleStyle}
                    >
                      <ModuleToolbarIcon icon={item.icon} />
                    </button>
                  );
                }

                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={item.checked}
                    onClick={() => {
                      dispatchToolbarChange(activePanel.id, item.id, item.command, !item.checked);
                    }}
                    title={item.tooltip || item.text || item.command}
                    className={cn(
                      "flex h-7 appearance-none items-center gap-2 rounded-full border-0 px-2.5 text-xs font-medium shadow-none outline-none ring-0 transition-colors focus:outline-none focus-visible:outline-none focus-visible:ring-0",
                      disabled
                        ? "cursor-not-allowed bg-zinc-900/70 text-zinc-600 opacity-70"
                        : "bg-zinc-900/90 text-zinc-200 hover:bg-zinc-800/90",
                    )}
                    style={style}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-7 items-center rounded-full border transition-colors",
                        item.checked
                          ? "border-zinc-500 bg-zinc-700"
                          : "border-zinc-700 bg-zinc-950",
                      )}
                    >
                      <span
                        className={cn(
                          "h-3 w-3 rounded-full bg-zinc-300 transition-transform",
                          item.checked ? "translate-x-3" : "translate-x-0.5",
                        )}
                      />
                    </span>
                    {item.text && <span className="max-w-32 truncate">{item.text}</span>}
                  </button>
                );
              }

              if (item.kind === "number") {
                return (
                  <ToolbarNumberInput
                    key={`${item.id}:${item.value}`}
                    item={item}
                    disabled={disabled}
                    style={style}
                    onValueChange={(value) => {
                      dispatchToolbarChange(activePanel.id, item.id, item.command, value);
                    }}
                  />
                );
              }

              if (item.kind === "slider") {
                return (
                  <ToolbarSlider
                    key={item.id}
                    item={item}
                    disabled={disabled}
                    style={style}
                    onValueChange={(value) => {
                      dispatchToolbarChange(activePanel.id, item.id, item.command, value);
                    }}
                  />
                );
              }

              if (item.kind === "segmented") {
                return (
                  <div
                    key={item.id}
                    title={item.tooltip || item.text || item.command}
                    className={cn(
                      "flex h-7 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/90",
                      disabled && "opacity-70",
                    )}
                    style={style}
                  >
                    {item.options.map((option) => {
                      const selected = option.value === item.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          disabled={disabled || option.disabled}
                          onClick={() => {
                            dispatchToolbarChange(
                              activePanel.id,
                              item.id,
                              item.command,
                              option.value,
                            );
                          }}
                          className={cn(
                            "h-full max-w-24 truncate px-2 text-xs font-medium transition-colors",
                            selected
                              ? "bg-zinc-700 text-zinc-100"
                              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
                            disabled || option.disabled
                              ? "cursor-not-allowed text-zinc-600"
                              : "cursor-default",
                          )}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                );
              }

              if (item.kind === "menu") {
                const actions = item.items.filter((action) => action.visible);
                if (actions.length === 0) return null;

                return (
                  <DropdownMenu key={item.id}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        disabled={disabled}
                        title={item.tooltip || item.text || item.command}
                        className={cn(
                          "flex h-7 appearance-none items-center gap-1.5 rounded-full border-0 px-3 text-xs font-medium shadow-none outline-none ring-0 transition-colors focus:outline-none focus-visible:outline-none focus-visible:ring-0",
                          disabled
                            ? "cursor-not-allowed bg-zinc-900/70 text-zinc-600 opacity-70"
                            : "bg-zinc-900/90 text-zinc-200 hover:bg-zinc-800/90",
                        )}
                        style={style}
                      >
                        {item.icon && <ModuleToolbarIcon icon={item.icon} />}
                        {item.text && <span className="max-w-32 truncate">{item.text}</span>}
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-40">
                      {actions.map((action) => (
                        <DropdownMenuItem
                          key={action.id}
                          disabled={action.disabled}
                          title={action.tooltip || action.text || action.command}
                          onSelect={() => {
                            dispatchToolbarClick(
                              activePanel.id,
                              action.id,
                              action.command,
                              item.id,
                            );
                          }}
                        >
                          {renderActionIcon(activePanelType, action.iconPath)}
                          <span className="truncate">{action.text || action.command}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              }

              if (item.kind === "buttonGroup") {
                const actions = item.items.filter((action) => action.visible);
                if (actions.length === 0) return null;

                return (
                  <div
                    key={item.id}
                    title={item.tooltip || item.text || item.command}
                    className={cn(
                      "flex h-7 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900/90",
                      disabled && "opacity-70",
                    )}
                    style={style}
                  >
                    {actions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        disabled={disabled || action.disabled}
                        onClick={() => {
                          dispatchToolbarClick(activePanel.id, action.id, action.command, item.id);
                        }}
                        title={action.tooltip || action.text || action.command}
                        className={cn(
                          "flex h-full items-center gap-1.5 px-2 text-xs font-medium transition-colors",
                          disabled || action.disabled
                            ? "cursor-not-allowed text-zinc-600"
                            : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                        )}
                      >
                        {renderActionIcon(activePanelType, action.iconPath)}
                        {(action.text || action.command) && (
                          <span className="max-w-20 truncate">{action.text || action.command}</span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              }

              if (item.kind === "status") {
                return (
                  <span
                    key={item.id}
                    title={item.tooltip || item.text}
                    className={cn(
                      "flex h-7 max-w-44 items-center gap-1.5 truncate rounded-full border px-2.5 text-xs font-medium",
                      toneClassName(item.tone),
                    )}
                    style={style}
                  >
                    {item.icon && <ModuleToolbarIcon icon={item.icon} />}
                    <span className="truncate">{item.text}</span>
                  </span>
                );
              }

              if (item.kind === "progress") {
                const progress = clampPercent(item.progress);
                return (
                  <div
                    key={item.id}
                    title={item.tooltip || item.text}
                    className={cn(
                      "flex h-7 min-w-32 max-w-52 items-center gap-2 rounded-full border px-2.5 text-xs font-medium",
                      toneClassName(item.tone),
                    )}
                    style={style}
                  >
                    {item.indeterminate ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : (
                      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-black/30">
                        <div
                          className="h-full rounded-full bg-current transition-[width]"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    )}
                    {item.text && <span className="truncate">{item.text}</span>}
                    {!item.indeterminate && item.showValue && (
                      <span className="shrink-0 tabular-nums">{Math.round(progress)}%</span>
                    )}
                  </div>
                );
              }

              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    dispatchToolbarClick(activePanel.id, item.id, item.command);
                  }}
                  title={item.tooltip || item.text || item.command}
                  className={cn(
                    "flex h-7 appearance-none items-center gap-1.5 rounded-full border-0 text-xs font-medium shadow-none outline-none ring-0 transition-colors focus:outline-none focus-visible:outline-none focus-visible:ring-0",
                    item.icon && !item.text ? "w-7 justify-center px-0" : "px-3",
                    disabled
                      ? "cursor-not-allowed bg-zinc-900/70 text-zinc-600 opacity-70"
                      : "bg-zinc-900/90 text-zinc-200 hover:bg-zinc-800/90",
                  )}
                  style={style}
                >
                  {item.icon && <ModuleToolbarIcon icon={item.icon} />}
                  {item.text && <span className="max-w-32 truncate">{item.text}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex-1" />

      <div className="mr-2 h-5 w-px shrink-0 bg-zinc-700" />

      <button
        type="button"
        disabled={!canTogglePanelFullscreen}
        onClick={() => {
          if (canTogglePanelFullscreen) {
            togglePanelFullscreen();
          }
        }}
        className={cn(
          "mr-1 flex h-9 w-9 items-center justify-center rounded text-zinc-400 transition-colors",
          canTogglePanelFullscreen ? "hover:bg-zinc-800" : "cursor-not-allowed opacity-50",
        )}
        title="Toggle panel fullscreen (Ctrl/Cmd+Shift+F)"
      >
        <FullscreenIcon className="h-4 w-4" />
      </button>

      <Popover open={searchOpen} onOpenChange={setSearchOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800"
            title="Find"
          >
            <Search className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 border-zinc-800 bg-zinc-950 p-2" align="end">
          <input
            type="text"
            placeholder="Find..."
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
            autoFocus
          />
        </PopoverContent>
      </Popover>

      <button
        type="button"
        className="flex h-9 w-9 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800"
        title="Settings"
      >
        <Settings className="h-4 w-4" />
      </button>
    </div>
  );
};

function ToolbarTextInput({
  item,
  disabled,
  style,
  onValueChange,
}: {
  item: RuntimePanelToolbarTextItem;
  disabled: boolean;
  style?: CSSProperties;
  onValueChange: (value: string) => void;
}) {
  const [value, setValue] = useState(item.value);

  return (
    <input
      type="text"
      value={value}
      disabled={disabled}
      placeholder={item.placeholder}
      onChange={(event) => {
        const nextValue = event.target.value;
        setValue(nextValue);
        onValueChange(nextValue);
      }}
      title={item.tooltip || item.text || item.command}
      className={cn(
        "h-7 w-36 rounded-md border border-zinc-800 bg-zinc-900/90 px-2 text-xs font-medium text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-70",
        disabled ? "bg-zinc-900/70" : "hover:bg-zinc-800/90",
      )}
      style={style}
    />
  );
}

function ToolbarNumberInput({
  item,
  disabled,
  style,
  onValueChange,
}: {
  item: RuntimePanelToolbarNumberItem;
  disabled: boolean;
  style?: CSSProperties;
  onValueChange: (value: number) => void;
}) {
  const [value, setValue] = useState(String(item.value));
  const max = item.max > item.min ? item.max : undefined;
  const step = item.step > 0 ? item.step : 1;

  return (
    <input
      type="number"
      value={value}
      disabled={disabled}
      min={item.min}
      max={max}
      step={step}
      placeholder={item.placeholder}
      onChange={(event) => {
        const nextValue = event.target.value;
        setValue(nextValue);
        const parsed = Number(nextValue);
        if (Number.isFinite(parsed)) {
          onValueChange(parsed);
        }
      }}
      title={item.tooltip || item.text || item.command}
      className={cn(
        "h-7 w-24 rounded-md border border-zinc-800 bg-zinc-900/90 px-2 text-xs font-medium tabular-nums text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-70",
        disabled ? "bg-zinc-900/70" : "hover:bg-zinc-800/90",
      )}
      style={style}
    />
  );
}

function ToolbarSlider({
  item,
  disabled,
  style,
  onValueChange,
}: {
  item: RuntimePanelToolbarSliderItem;
  disabled: boolean;
  style?: CSSProperties;
  onValueChange: (value: number) => void;
}) {
  const min = item.min;
  const max = item.max > item.min ? item.max : item.min + 100;
  const step = item.step > 0 ? item.step : 1;
  const value = Math.min(Math.max(item.value, min), max);

  return (
    <div
      title={item.tooltip || item.text || item.command}
      className={cn(
        "flex h-7 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/90 px-2",
        disabled && "opacity-70",
      )}
      style={style}
    >
      {item.text && <span className="max-w-20 truncate text-xs font-medium">{item.text}</span>}
      <input
        type="range"
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) {
            onValueChange(parsed);
          }
        }}
        className="h-1.5 w-24 accent-zinc-300 disabled:cursor-not-allowed"
      />
      {item.showValue && (
        <span className="w-8 shrink-0 text-right text-xs tabular-nums text-zinc-400">
          {formatToolbarNumber(value)}
        </span>
      )}
    </div>
  );
}

function renderActionIcon(
  panelType: ReturnType<typeof getPanelMetadata>,
  iconPath: string,
): ReactNode {
  if (!panelType || !iconPath) {
    return null;
  }

  const icon = resolvePanelToolbarIconSource(panelType, iconPath);
  return icon ? <ModuleToolbarIcon icon={icon} /> : null;
}

function applyToolbarPatch(
  item: RuntimePanelToolbarItem,
  patch: PanelToolbarItemPatch | undefined,
): RuntimePanelToolbarItem {
  if (!patch) {
    return item;
  }

  const next = {
    ...item,
    ...patch,
    kind: item.kind,
  };

  if (item.kind === "select") {
    return {
      ...next,
      kind: "select",
      value: typeof patch.value === "string" ? patch.value : item.value,
      placeholder: typeof patch.placeholder === "string" ? patch.placeholder : item.placeholder,
      options: patch.options ?? item.options,
    };
  }

  if (item.kind === "text") {
    return {
      ...next,
      kind: "text",
      value: typeof patch.value === "string" ? patch.value : item.value,
      placeholder: typeof patch.placeholder === "string" ? patch.placeholder : item.placeholder,
    };
  }

  if (item.kind === "toggle") {
    return {
      ...next,
      kind: "toggle",
      checked: typeof patch.checked === "boolean" ? patch.checked : item.checked,
    };
  }

  if (item.kind === "number") {
    return {
      ...next,
      kind: "number",
      value: typeof patch.value === "number" ? patch.value : item.value,
      min: typeof patch.min === "number" ? patch.min : item.min,
      max: typeof patch.max === "number" ? patch.max : item.max,
      step: typeof patch.step === "number" ? patch.step : item.step,
      placeholder: typeof patch.placeholder === "string" ? patch.placeholder : item.placeholder,
    };
  }

  if (item.kind === "slider") {
    return {
      ...next,
      kind: "slider",
      value: typeof patch.value === "number" ? patch.value : item.value,
      min: typeof patch.min === "number" ? patch.min : item.min,
      max: typeof patch.max === "number" ? patch.max : item.max,
      step: typeof patch.step === "number" ? patch.step : item.step,
      showValue: typeof patch.showValue === "boolean" ? patch.showValue : item.showValue,
    };
  }

  if (item.kind === "segmented") {
    return {
      ...next,
      kind: "segmented",
      value: typeof patch.value === "string" ? patch.value : item.value,
      options: patch.options ?? item.options,
    };
  }

  if (item.kind === "menu") {
    return {
      ...next,
      kind: "menu",
      items: patch.items ?? item.items,
    };
  }

  if (item.kind === "buttonGroup") {
    return {
      ...next,
      kind: "buttonGroup",
      items: patch.items ?? item.items,
    };
  }

  if (item.kind === "status") {
    return {
      ...next,
      kind: "status",
      tone: typeof patch.tone === "string" ? patch.tone : item.tone,
    };
  }

  if (item.kind === "progress") {
    return {
      ...next,
      kind: "progress",
      progress: typeof patch.progress === "number" ? patch.progress : item.progress,
      indeterminate:
        typeof patch.indeterminate === "boolean" ? patch.indeterminate : item.indeterminate,
      showValue: typeof patch.showValue === "boolean" ? patch.showValue : item.showValue,
      tone: typeof patch.tone === "string" ? patch.tone : item.tone,
    };
  }

  return next as RuntimePanelToolbarItem;
}

function toneClassName(tone: string): string {
  switch (tone.trim()) {
    case "success":
      return "border-emerald-800/70 bg-emerald-950/70 text-emerald-300";
    case "warning":
      return "border-amber-800/70 bg-amber-950/70 text-amber-300";
    case "danger":
    case "error":
      return "border-rose-800/70 bg-rose-950/70 text-rose-300";
    case "info":
      return "border-sky-800/70 bg-sky-950/70 text-sky-300";
    case "muted":
      return "border-zinc-800 bg-zinc-900/80 text-zinc-500";
    default:
      return "border-zinc-800 bg-zinc-900/90 text-zinc-300";
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

function formatToolbarNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
