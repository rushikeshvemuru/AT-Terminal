import { useEffect, useMemo, useRef, useState } from "react";
import type { Panel } from "@/store/useTabStore";
import {
  buildPanelPopupUrl,
  buildPanelUrl,
  getCreatableTypes,
  getModulePanelOrigin,
  type PanelState,
  type PanelPopupCloseMessage,
  type PanelPopupOpenMessage,
  type PanelToolbarChangeMessage,
  type PanelToolbarClickMessage,
  type RuntimePanelToolbarActionItem,
  type PanelToolbarItemPatch,
  type PanelToolbarPatchMessage,
  type RuntimePanelToolbarItem,
  type RuntimePanelToolbarItemKind,
  type RuntimePanelToolbarOption,
  type RuntimePanelType,
} from "@/lib/panelRegistry";
import { isEditableTarget, isPanelFullscreenHotkey } from "@/lib/panelFullscreenHotkey";
import { usePanelPopupStore } from "@/store/usePanelPopupStore";
import { usePanelFullscreenStore } from "@/store/usePanelFullscreenStore";
import { usePanelToolbarStore } from "@/store/usePanelToolbarStore";

interface ModulePanelHostProps {
  panel: Panel;
  panelType: RuntimePanelType;
  rootDirectory: string;
  isActive: boolean;
  onChangeType?: (type: string) => void;
  onPanelStateChange?: (state: PanelState) => void;
}

interface ModuleMessage {
  type?: string;
  requestId?: string;
  panelId?: string;
  panelType?: string;
  route?: string;
  title?: string;
  width?: unknown;
  height?: unknown;
  popupId?: string;
  items?: unknown;
  panelState?: unknown;
}

const HEALTH_REVALIDATION_INTERVAL_MS = 5000;

function isExpectedPanelOrigin(eventOrigin: string, expectedOrigin: string | null): boolean {
  return expectedOrigin !== null && eventOrigin === expectedOrigin;
}

export const ModulePanelHost = ({
  panel,
  panelType,
  rootDirectory,
  isActive,
  onChangeType,
  onPanelStateChange,
}: ModulePanelHostProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeHotkeyCleanupRef = useRef<(() => void) | null>(null);
  const hasLoadedRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const registerPanelSender = usePanelToolbarStore((s) => s.registerPanelSender);
  const unregisterPanelSender = usePanelToolbarStore((s) => s.unregisterPanelSender);
  const setPanelReady = usePanelToolbarStore((s) => s.setPanelReady);
  const applyItemPatches = usePanelToolbarStore((s) => s.applyItemPatches);
  const setToolbarItems = usePanelToolbarStore((s) => s.setToolbarItems);
  const resetPanelToolbar = usePanelToolbarStore((s) => s.resetPanelToolbar);
  const clearPanelToolbar = usePanelToolbarStore((s) => s.clearPanelToolbar);
  const runtimeToolbarItems = usePanelToolbarStore((s) => s.panels[panel.id]?.runtimeItems);
  const openPopup = usePanelPopupStore((s) => s.openPopup);
  const closePopupForPanel = usePanelPopupStore((s) => s.closePopupForPanel);
  const togglePanelFullscreen = usePanelFullscreenStore((s) => s.togglePanelFullscreen);
  const [status, setStatus] = useState<
    "idle" | "waiting_for_health" | "loading_iframe" | "ready" | "failed"
  >("idle");
  const [retryCount, setRetryCount] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const [iframeSrc, setIframeSrc] = useState<string | undefined>(undefined);
  const startupCommand =
    typeof panel.state?.startupCommand === "string" ? panel.state.startupCommand : undefined;
  const startupNonce =
    typeof panel.state?.startupNonce === "string" ? panel.state.startupNonce : undefined;
  const url = useMemo(
    () =>
      buildPanelUrl(panelType, panel.id, panel.type, rootDirectory, startupCommand, startupNonce),
    [panel.id, panel.type, panelType, rootDirectory, startupCommand, startupNonce],
  );
  const healthcheckUrl = panelType.healthcheckUrl.trim();
  const panelOrigin = useMemo(
    () => getModulePanelOrigin(panelType.panelUrlTemplate),
    [panelType.panelUrlTemplate],
  );

  useEffect(() => {
    const sender = (message: PanelToolbarClickMessage | PanelToolbarChangeMessage) => {
      iframeRef.current?.contentWindow?.postMessage(message, panelOrigin ?? "*");
    };

    registerPanelSender(panel.id, sender);
    return () => {
      unregisterPanelSender(panel.id);
      clearPanelToolbar(panel.id);
    };
  }, [clearPanelToolbar, panel.id, panelOrigin, registerPanelSender, unregisterPanelSender]);

  useEffect(() => {
    let cancelled = false;
    hasLoadedRef.current = false;
    retryCountRef.current = 0;
    resetPanelToolbar(panel.id);

    queueMicrotask(() => {
      if (cancelled) return;
      setRetryCount(0);
      setRetryTick(0);
      setIframeSrc(undefined);
      setStatus("idle");
    });

    return () => {
      cancelled = true;
    };
  }, [healthcheckUrl, panel.id, resetPanelToolbar, url]);

  useEffect(() => {
    return () => {
      iframeHotkeyCleanupRef.current?.();
      iframeHotkeyCleanupRef.current = null;
      closePopupForPanel(panel.id);
    };
  }, [closePopupForPanel, panel.id]);

  useEffect(() => {
    if (!iframeRef.current?.contentWindow) {
      return;
    }

    iframeRef.current.contentWindow.postMessage(
      {
        type: "at.panelState.sync",
        panelId: panel.id,
        panelState: panel.state ?? {},
      },
      panelOrigin ?? "*",
    );
  }, [panel.id, panel.state, panelOrigin, status]);

  useEffect(() => {
    if (!isActive || hasLoadedRef.current) return;

    let cancelled = false;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    const scheduleRetry = (attempt: number) => {
      const delayMs = getRetryDelayMs(attempt);
      retryTimerRef.current = window.setTimeout(() => {
        setRetryTick((value) => value + 1);
      }, delayMs);
    };

    const startLoad = async () => {
      if (healthcheckUrl.length === 0) {
        setStatus("loading_iframe");
        setIframeSrc(url);
        return;
      }

      setStatus((current) => (current === "failed" ? "failed" : "waiting_for_health"));
      const healthy = await isHealthcheckReady(healthcheckUrl);
      if (cancelled || hasLoadedRef.current) return;

      if (healthy) {
        setStatus("loading_iframe");
        setIframeSrc(url);
        return;
      }

      const nextAttempt = retryCountRef.current + 1;
      retryCountRef.current = nextAttempt;
      setRetryCount(nextAttempt);
      setStatus(nextAttempt >= 5 ? "failed" : "waiting_for_health");
      scheduleRetry(nextAttempt);
    };

    startLoad();

    return () => {
      cancelled = true;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [healthcheckUrl, isActive, retryTick, url]);

  useEffect(() => {
    if (!isActive || status !== "ready" || healthcheckUrl.length === 0) {
      return;
    }

    let cancelled = false;
    let checking = false;

    const revalidate = async () => {
      if (checking) return;
      checking = true;
      const healthy = await isHealthcheckReady(healthcheckUrl);
      checking = false;
      if (cancelled || healthy) return;

      hasLoadedRef.current = false;
      retryCountRef.current = 0;
      setRetryCount(0);
      setIframeSrc(undefined);
      resetPanelToolbar(panel.id);
      setStatus("waiting_for_health");
      setRetryTick((value) => value + 1);
    };

    const timer = window.setInterval(revalidate, HEALTH_REVALIDATION_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [healthcheckUrl, isActive, panel.id, resetPanelToolbar, status]);

  useEffect(() => {
    if (!isActive || !iframeSrc || status !== "ready") {
      return;
    }

    const iframeWindow = iframeRef.current?.contentWindow;
    const iframeDocument = iframeRef.current?.contentDocument;
    if (!iframeWindow || !iframeDocument) {
      return;
    }

    iframeHotkeyCleanupRef.current?.();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isPanelFullscreenHotkey(event)) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      togglePanelFullscreen();
    };

    iframeWindow.addEventListener("keydown", handleKeyDown, true);
    iframeDocument.addEventListener("keydown", handleKeyDown, true);
    iframeHotkeyCleanupRef.current = () => {
      iframeWindow.removeEventListener("keydown", handleKeyDown, true);
      iframeDocument.removeEventListener("keydown", handleKeyDown, true);
    };

    return () => {
      iframeHotkeyCleanupRef.current?.();
      iframeHotkeyCleanupRef.current = null;
    };
  }, [iframeSrc, isActive, status, togglePanelFullscreen]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ModuleMessage>) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }

      if (!isExpectedPanelOrigin(event.origin, panelOrigin)) {
        console.warn(
          `[modules] Ignoring message for panel '${panel.id}' from unexpected origin '${event.origin}'.`,
        );
        return;
      }

      const message = event.data;
      if (!message || typeof message !== "object") return;

      if (message.type === "at.changePanelType") {
        if (message.panelId === panel.id && message.panelType) {
          onChangeType?.(message.panelType);
        }
        return;
      }

      if (message.type === "at.listPanelTypes") {
        iframeRef.current.contentWindow?.postMessage(
          {
            type: "at.panelTypes",
            requestId: message.requestId,
            panelId: panel.id,
            panelTypes: getCreatableTypes(),
          },
          event.origin,
        );
        return;
      }

      if (message.type === "at.panelToolbar.patch") {
        if (message.panelId !== panel.id) return;

        const currentItems = runtimeToolbarItems ?? panelType.panelToolbar?.items ?? [];
        const itemIds = new Set(currentItems.map((item) => item.id));
        const patches = parseToolbarPatches(
          message as PanelToolbarPatchMessage,
          itemIds,
          panelType.type,
        );
        applyItemPatches(panel.id, patches);
        return;
      }

      if (message.type === "at.panelToolbar.set") {
        if (message.panelId !== panel.id) return;

        const items = parseRuntimeToolbarItems(message.items, panelType.type);
        if (!items) return;

        setToolbarItems(panel.id, items);
        return;
      }

      if (message.type === "at.panelState.patch") {
        if (message.panelId !== panel.id) return;
        if (!message.panelState || typeof message.panelState !== "object") return;

        onPanelStateChange?.({
          ...(panel.state ?? {}),
          ...(message.panelState as PanelState),
        });
        return;
      }

      if (message.type === "at.panelPopup.open") {
        const popupMessage = parsePopupOpenMessage(message, panel.id);
        if (!popupMessage) return;

        const popupId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${panel.id}-popup-${Date.now()}`;
        const popupSrc = buildPanelPopupUrl(panelType, panel.type, popupMessage.route, popupId);
        if (!popupSrc) {
          console.warn(
            `[modules] Ignoring popup open request for panel '${panel.id}' because the route '${popupMessage.route}' is invalid or crosses origins.`,
          );
          return;
        }

        openPopup({
          popupId,
          sourcePanelId: panel.id,
          title: popupMessage.title,
          src: popupSrc,
          width: popupMessage.width,
          height: popupMessage.height,
        });
        return;
      }

      if (message.type === "at.panelPopup.close") {
        const popupCloseMessage = message as PanelPopupCloseMessage;
        if (popupCloseMessage.panelId === panel.id) {
          closePopupForPanel(panel.id);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    applyItemPatches,
    closePopupForPanel,
    onChangeType,
    onPanelStateChange,
    openPopup,
    panel.id,
    panel.state,
    panel.type,
    panelOrigin,
    panelType.panelToolbar,
    panelType.type,
    panelType,
    runtimeToolbarItems,
    setToolbarItems,
  ]);

  return (
    <div className="relative flex h-full w-full flex-1">
      {isActive && status !== "ready" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/95 text-xs text-zinc-400">
          <div className="flex flex-col items-center gap-2">
            <span>
              {status === "failed"
                ? "Module panel is still starting."
                : "Waiting for module panel to become ready..."}
            </span>
            <button
              onClick={() => {
                if (retryTimerRef.current !== null) {
                  window.clearTimeout(retryTimerRef.current);
                  retryTimerRef.current = null;
                }
                retryCountRef.current = 0;
                setRetryCount(0);
                setStatus("waiting_for_health");
                setRetryTick((value) => value + 1);
              }}
              className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Retry now
            </button>
            {retryCount > 0 && (
              <span className="text-[11px] text-zinc-500">Attempts: {retryCount}</span>
            )}
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        title={`${panel.name} module panel`}
        src={iframeSrc}
        onLoad={() => {
          if (!iframeSrc) return;
          hasLoadedRef.current = true;
          setPanelReady(panel.id, true);
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: "at.panelState.sync",
              panelId: panel.id,
              panelState: panel.state ?? {},
            },
            panelOrigin ?? "*",
          );
          setStatus("ready");
        }}
        onError={() => {
          hasLoadedRef.current = false;
          setIframeSrc(undefined);
          resetPanelToolbar(panel.id);
          setStatus("failed");
          setRetryTick((value) => value + 1);
        }}
        className="h-full w-full flex-1 border-0 bg-zinc-950"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
};

function parseToolbarPatches(
  message: PanelToolbarPatchMessage,
  validItemIds: Set<string>,
  panelType: string,
): PanelToolbarItemPatch[] {
  if (!Array.isArray(message.items)) {
    return [];
  }

  const patches: PanelToolbarItemPatch[] = [];

  for (const item of message.items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const rawId = "id" in item && typeof item.id === "string" ? item.id.trim() : "";
    if (!rawId) {
      continue;
    }

    if (!validItemIds.has(rawId)) {
      console.warn(
        `[modules] Ignoring toolbar patch for unknown item '${rawId}' on panel type '${panelType}'.`,
      );
      continue;
    }

    const patch: PanelToolbarItemPatch = { id: rawId };
    if ("text" in item && typeof item.text === "string") patch.text = item.text;
    if ("iconPath" in item && typeof item.iconPath === "string") patch.iconPath = item.iconPath;
    if ("color" in item && typeof item.color === "string") patch.color = item.color;
    if ("tooltip" in item && typeof item.tooltip === "string") patch.tooltip = item.tooltip;
    if ("visible" in item && typeof item.visible === "boolean") patch.visible = item.visible;
    if ("disabled" in item && typeof item.disabled === "boolean") {
      patch.disabled = item.disabled;
    }
    if ("value" in item && (typeof item.value === "string" || typeof item.value === "number")) {
      patch.value = item.value;
    }
    if ("placeholder" in item && typeof item.placeholder === "string") {
      patch.placeholder = item.placeholder;
    }
    if ("checked" in item && typeof item.checked === "boolean") patch.checked = item.checked;
    if ("options" in item && Array.isArray(item.options)) {
      patch.options = parseToolbarOptions(item.options);
    }
    if ("min" in item && typeof item.min === "number" && Number.isFinite(item.min)) {
      patch.min = item.min;
    }
    if ("max" in item && typeof item.max === "number" && Number.isFinite(item.max)) {
      patch.max = item.max;
    }
    if ("step" in item && typeof item.step === "number" && Number.isFinite(item.step)) {
      patch.step = item.step;
    }
    if ("showValue" in item && typeof item.showValue === "boolean") {
      patch.showValue = item.showValue;
    }
    if ("tone" in item && typeof item.tone === "string") patch.tone = item.tone;
    if ("progress" in item && typeof item.progress === "number" && Number.isFinite(item.progress)) {
      patch.progress = clampNumber(item.progress, 0, 100);
    }
    if ("indeterminate" in item && typeof item.indeterminate === "boolean") {
      patch.indeterminate = item.indeterminate;
    }
    if ("items" in item && Array.isArray(item.items)) {
      patch.items = parseToolbarActions(item.items);
    }
    patches.push(patch);
  }

  return patches;
}

function parseRuntimeToolbarItems(
  value: unknown,
  panelType: string,
): RuntimePanelToolbarItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const seenIds = new Set<string>();
  const items: RuntimePanelToolbarItem[] = [];

  for (const rawItem of value) {
    if (!rawItem || typeof rawItem !== "object") {
      continue;
    }

    const id = readString(rawItem, "id").trim();
    if (!id) {
      continue;
    }

    if (seenIds.has(id)) {
      console.warn(
        `[modules] Ignoring duplicate runtime toolbar item id '${id}' on panel type '${panelType}'.`,
      );
      continue;
    }

    const kind = parseToolbarKind(readString(rawItem, "kind"), panelType, id);
    if (!kind) {
      continue;
    }

    seenIds.add(id);
    const base = {
      id,
      kind,
      text: readString(rawItem, "text"),
      iconPath: readString(rawItem, "iconPath") || readString(rawItem, "icon_path"),
      color: readString(rawItem, "color"),
      tooltip: readString(rawItem, "tooltip"),
      command: readString(rawItem, "command"),
      visible: readBoolean(rawItem, "visible", true),
      disabled: readBoolean(rawItem, "disabled", false),
    };

    if (kind === "select") {
      items.push({
        ...base,
        kind,
        value: readString(rawItem, "value"),
        placeholder: readString(rawItem, "placeholder"),
        options: parseToolbarOptions(readUnknown(rawItem, "options")),
      });
      continue;
    }

    if (kind === "text") {
      items.push({
        ...base,
        kind,
        value: readString(rawItem, "value"),
        placeholder: readString(rawItem, "placeholder"),
      });
      continue;
    }

    if (kind === "toggle") {
      items.push({
        ...base,
        kind,
        checked: readBoolean(rawItem, "checked", false),
      });
      continue;
    }

    if (kind === "number") {
      items.push({
        ...base,
        kind,
        value: readNumber(rawItem, "value", 0),
        min: readNumber(rawItem, "min", 0),
        max: readNumber(rawItem, "max", 0),
        step: readNumber(rawItem, "step", 1),
        placeholder: readString(rawItem, "placeholder"),
      });
      continue;
    }

    if (kind === "slider") {
      items.push({
        ...base,
        kind,
        value: readNumber(rawItem, "value", 0),
        min: readNumber(rawItem, "min", 0),
        max: readNumber(rawItem, "max", 100),
        step: readNumber(rawItem, "step", 1),
        showValue: readBoolean(rawItem, "showValue", false),
      });
      continue;
    }

    if (kind === "segmented") {
      items.push({
        ...base,
        kind,
        value: readString(rawItem, "value"),
        options: parseToolbarOptions(readUnknown(rawItem, "options")),
      });
      continue;
    }

    if (kind === "menu") {
      items.push({
        ...base,
        kind,
        items: parseToolbarActions(readUnknown(rawItem, "items")),
      });
      continue;
    }

    if (kind === "buttonGroup") {
      items.push({
        ...base,
        kind,
        items: parseToolbarActions(readUnknown(rawItem, "items")),
      });
      continue;
    }

    if (kind === "status") {
      items.push({
        ...base,
        kind,
        tone: readString(rawItem, "tone"),
      });
      continue;
    }

    if (kind === "progress") {
      items.push({
        ...base,
        kind,
        progress: clampNumber(readNumber(rawItem, "progress", 0), 0, 100),
        indeterminate: readBoolean(rawItem, "indeterminate", false),
        showValue: readBoolean(rawItem, "showValue", false),
        tone: readString(rawItem, "tone"),
      });
      continue;
    }

    items.push({
      ...base,
      kind,
    } as RuntimePanelToolbarItem);
  }

  return items;
}

function parseToolbarKind(
  value: string,
  panelType: string,
  itemId: string,
): RuntimePanelToolbarItemKind | null {
  const kind = value.trim() || "button";
  if (
    kind === "button" ||
    kind === "select" ||
    kind === "text" ||
    kind === "toggle" ||
    kind === "number" ||
    kind === "slider" ||
    kind === "segmented" ||
    kind === "menu" ||
    kind === "buttonGroup" ||
    kind === "status" ||
    kind === "progress" ||
    kind === "separator" ||
    kind === "label" ||
    kind === "spacer"
  ) {
    return kind;
  }

  console.warn(
    `[modules] Ignoring runtime toolbar item '${itemId}' on panel type '${panelType}' with unsupported kind '${kind}'.`,
  );
  return null;
}

function parseToolbarOptions(value: unknown): RuntimePanelToolbarOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const options: RuntimePanelToolbarOption[] = [];
  const seenValues = new Set<string>();

  for (const rawOption of value) {
    if (!rawOption || typeof rawOption !== "object") {
      continue;
    }

    const optionValue = readString(rawOption, "value").trim();
    if (!optionValue || seenValues.has(optionValue)) {
      continue;
    }

    seenValues.add(optionValue);
    const label = readString(rawOption, "label").trim();
    options.push({
      value: optionValue,
      label: label || optionValue,
      disabled: readBoolean(rawOption, "disabled", false),
    });
  }

  return options;
}

function parseToolbarActions(value: unknown): RuntimePanelToolbarActionItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const actions: RuntimePanelToolbarActionItem[] = [];
  const seenIds = new Set<string>();

  for (const rawAction of value) {
    if (!rawAction || typeof rawAction !== "object") {
      continue;
    }

    const id = readString(rawAction, "id").trim();
    if (!id || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    actions.push({
      id,
      text: readString(rawAction, "text"),
      iconPath: readString(rawAction, "iconPath") || readString(rawAction, "icon_path"),
      tooltip: readString(rawAction, "tooltip"),
      command: readString(rawAction, "command"),
      visible: readBoolean(rawAction, "visible", true),
      disabled: readBoolean(rawAction, "disabled", false),
    });
  }

  return actions;
}

function readUnknown(value: object, key: string): unknown {
  return key in value ? value[key as keyof typeof value] : undefined;
}

function readString(value: object, key: string): string {
  const field = readUnknown(value, key);
  return typeof field === "string" ? field : "";
}

function readBoolean(value: object, key: string, fallback: boolean): boolean {
  const field = readUnknown(value, key);
  return typeof field === "boolean" ? field : fallback;
}

function readNumber(value: object, key: string, fallback: number): number {
  const field = readUnknown(value, key);
  if (typeof field === "number" && Number.isFinite(field)) {
    return field;
  }

  if (typeof field === "string") {
    const parsed = Number(field);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getRetryDelayMs(attempt: number): number {
  if (attempt <= 2) return 500;
  if (attempt <= 5) return 1000;
  if (attempt <= 10) return 2000;
  return 5000;
}

async function isHealthcheckReady(healthcheckUrl: string): Promise<boolean> {
  const timeout = 1200;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(healthcheckUrl, {
      method: "GET",
      cache: "no-store",
      mode: "no-cors",
      signal: controller.signal,
    });
    return response.ok || response.type === "opaque";
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

function parsePopupOpenMessage(
  value: ModuleMessage,
  panelId: string,
): (PanelPopupOpenMessage & { title: string; width: number; height: number }) | null {
  if (value.panelId !== panelId || typeof value.route !== "string") {
    return null;
  }

  const route = value.route.trim();
  if (!route) {
    return null;
  }

  return {
    type: "at.panelPopup.open",
    panelId,
    route,
    title: typeof value.title === "string" && value.title.trim().length > 0 ? value.title : "",
    width: sanitizePopupDimension(value.width, 720),
    height: sanitizePopupDimension(value.height, 520),
  };
}

function sanitizePopupDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(value);
}
