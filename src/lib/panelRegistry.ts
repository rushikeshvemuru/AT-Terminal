import { useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import type { Panel } from "@/store/useTabStore";

export type RuntimePanelToolbarItemKind =
  | "button"
  | "select"
  | "text"
  | "toggle"
  | "number"
  | "slider"
  | "segmented"
  | "menu"
  | "buttonGroup"
  | "status"
  | "progress"
  | "separator"
  | "label"
  | "spacer";

export interface RuntimePanelToolbarOption {
  value: string;
  label: string;
  disabled: boolean;
}

export interface RuntimePanelToolbarActionItem {
  id: string;
  text: string;
  iconPath: string;
  tooltip: string;
  command: string;
  visible: boolean;
  disabled: boolean;
}

interface RuntimePanelToolbarItemBase {
  id: string;
  kind: RuntimePanelToolbarItemKind;
  text: string;
  iconPath: string;
  color: string;
  tooltip: string;
  command: string;
  visible: boolean;
  disabled: boolean;
}

export interface RuntimePanelToolbarButtonItem extends RuntimePanelToolbarItemBase {
  kind: "button";
}

export interface RuntimePanelToolbarSelectItem extends RuntimePanelToolbarItemBase {
  kind: "select";
  value: string;
  placeholder: string;
  options: RuntimePanelToolbarOption[];
}

export interface RuntimePanelToolbarTextItem extends RuntimePanelToolbarItemBase {
  kind: "text";
  value: string;
  placeholder: string;
}

export interface RuntimePanelToolbarToggleItem extends RuntimePanelToolbarItemBase {
  kind: "toggle";
  checked: boolean;
}

export interface RuntimePanelToolbarNumberItem extends RuntimePanelToolbarItemBase {
  kind: "number";
  value: number;
  min: number;
  max: number;
  step: number;
  placeholder: string;
}

export interface RuntimePanelToolbarSliderItem extends RuntimePanelToolbarItemBase {
  kind: "slider";
  value: number;
  min: number;
  max: number;
  step: number;
  showValue: boolean;
}

export interface RuntimePanelToolbarSegmentedItem extends RuntimePanelToolbarItemBase {
  kind: "segmented";
  value: string;
  options: RuntimePanelToolbarOption[];
}

export interface RuntimePanelToolbarMenuItem extends RuntimePanelToolbarItemBase {
  kind: "menu";
  items: RuntimePanelToolbarActionItem[];
}

export interface RuntimePanelToolbarButtonGroupItem extends RuntimePanelToolbarItemBase {
  kind: "buttonGroup";
  items: RuntimePanelToolbarActionItem[];
}

export interface RuntimePanelToolbarStatusItem extends RuntimePanelToolbarItemBase {
  kind: "status";
  tone: string;
}

export interface RuntimePanelToolbarProgressItem extends RuntimePanelToolbarItemBase {
  kind: "progress";
  progress: number;
  indeterminate: boolean;
  showValue: boolean;
  tone: string;
}

export interface RuntimePanelToolbarSeparatorItem extends RuntimePanelToolbarItemBase {
  kind: "separator";
}

export interface RuntimePanelToolbarLabelItem extends RuntimePanelToolbarItemBase {
  kind: "label";
}

export interface RuntimePanelToolbarSpacerItem extends RuntimePanelToolbarItemBase {
  kind: "spacer";
}

export type RuntimePanelToolbarItem =
  | RuntimePanelToolbarButtonItem
  | RuntimePanelToolbarSelectItem
  | RuntimePanelToolbarTextItem
  | RuntimePanelToolbarToggleItem
  | RuntimePanelToolbarNumberItem
  | RuntimePanelToolbarSliderItem
  | RuntimePanelToolbarSegmentedItem
  | RuntimePanelToolbarMenuItem
  | RuntimePanelToolbarButtonGroupItem
  | RuntimePanelToolbarStatusItem
  | RuntimePanelToolbarProgressItem
  | RuntimePanelToolbarSeparatorItem
  | RuntimePanelToolbarLabelItem
  | RuntimePanelToolbarSpacerItem;

export interface RuntimePanelToolbar {
  items: RuntimePanelToolbarItem[];
}

export interface PanelToolbarItemPatch {
  id: string;
  text?: string;
  iconPath?: string;
  color?: string;
  tooltip?: string;
  visible?: boolean;
  disabled?: boolean;
  value?: string | number;
  placeholder?: string;
  checked?: boolean;
  min?: number;
  max?: number;
  step?: number;
  showValue?: boolean;
  tone?: string;
  progress?: number;
  indeterminate?: boolean;
  options?: RuntimePanelToolbarOption[];
  items?: RuntimePanelToolbarActionItem[];
}

export interface PanelToolbarClickMessage {
  type: "at.panelToolbar.click";
  panelId: string;
  itemId: string;
  command: string;
  parentItemId?: string;
}

export interface PanelToolbarChangeMessage {
  type: "at.panelToolbar.change";
  panelId: string;
  itemId: string;
  command: string;
  value: string | boolean | number;
}

export interface PanelToolbarPatchMessage {
  type: "at.panelToolbar.patch";
  panelId: string;
  items: PanelToolbarItemPatch[];
}

export interface PanelToolbarSetMessage {
  type: "at.panelToolbar.set";
  panelId: string;
  items: RuntimePanelToolbarItem[];
}

export interface PanelStatePatchMessage {
  type: "at.panelState.patch";
  panelId: string;
  panelState: PanelState;
}

export interface PanelStateSyncMessage {
  type: "at.panelState.sync";
  panelId: string;
  panelState: PanelState;
}

export interface PanelPopupOpenMessage {
  type: "at.panelPopup.open";
  panelId: string;
  route: string;
  title?: string;
  width?: number;
  height?: number;
}

export interface PanelPopupCloseMessage {
  type: "at.panelPopup.close";
  panelId?: string;
  popupId?: string;
}

export interface RuntimePanelType {
  type: string;
  localType: string;
  moduleName: string;
  displayName: string;
  color: string;
  panelUrlTemplate: string;
  healthcheckUrl: string;
  authToken?: string;
  panelToolbar?: RuntimePanelToolbar;
}

export interface RuntimeModule {
  moduleName: string;
  moduleDir: string;
  panelTypes: RuntimePanelType[];
  healthcheckUrl: string;
}

export interface ModuleRegistrySnapshot {
  modules: RuntimeModule[];
  panelTypes: RuntimePanelType[];
}

export const EMPTY_PANEL_TYPE = "base.empty" as const;
export const TERMINAL_PANEL_TYPE = "base.terminal" as const;
export const MONACO_PANEL_TYPE = "base.monaco" as const;
export const BROWSER_PANEL_TYPE = "base.browser_preview" as const;

export type PanelState = Record<string, unknown>;

export interface PanelProps {
  panel: Panel;
  rootDirectory: string;
  isActive: boolean;
  onChangeType?: (type: string) => void;
  onPanelStateChange?: (state: PanelState) => void;
}

export interface NativePanelRegistration {
  type: string;
  component: ComponentType<PanelProps>;
}

const emptySnapshot: ModuleRegistrySnapshot = {
  modules: [],
  panelTypes: [],
};

let snapshot: ModuleRegistrySnapshot = emptySnapshot;
const listeners = new Set<() => void>();
const nativePanels = new Map<string, ComponentType<PanelProps>>();

export function setModuleRegistry(nextSnapshot: ModuleRegistrySnapshot): void {
  snapshot = nextSnapshot;
  listeners.forEach((listener) => listener());
}

export function getModuleRegistry(): ModuleRegistrySnapshot {
  return snapshot;
}

export function getPanelMetadata(type: string): RuntimePanelType | undefined {
  return snapshot.panelTypes.find((entry) => entry.type === type);
}

export function getPanelColor(type: string): string {
  return getPanelMetadata(type)?.color || "#ffffff";
}

export function getPanelTypes(): RuntimePanelType[] {
  return snapshot.panelTypes;
}

export function getPanelTypeNames(): string[] {
  return snapshot.panelTypes.map((entry) => entry.type);
}

export function getCreatableTypes(): RuntimePanelType[] {
  return snapshot.panelTypes;
}

export function getPanelToolbarItems(type: string): RuntimePanelToolbarItem[] {
  return getPanelMetadata(type)?.panelToolbar?.items ?? [];
}

export function getModulePanelOrigin(panelUrlTemplate: string): string | null {
  try {
    return new URL(panelUrlTemplate).origin;
  } catch {
    return null;
  }
}

export function buildPanelUrl(
  panelType: RuntimePanelType,
  panelId: string,
  namespacedType: string,
  rootDirectory: string,
  startupCommand?: string,
  startupNonce?: string,
): string {
  const url = resolvePanelUrlTemplate(panelType, namespacedType);
  url.searchParams.set("panelId", panelId);
  url.searchParams.set("panelType", namespacedType);
  url.searchParams.set("localType", panelType.localType);
  url.searchParams.set("rootDirectory", rootDirectory);
  if (typeof startupCommand === "string" && startupCommand.trim().length > 0) {
    url.searchParams.set("startupCommand", startupCommand);
  }
  if (typeof startupNonce === "string" && startupNonce.length > 0) {
    url.searchParams.set("startupNonce", startupNonce);
  }
  applyPanelAuth(url, panelType);
  return url.toString();
}

export function buildPanelPopupUrl(
  panelType: RuntimePanelType,
  namespacedType: string,
  route: string,
  popupId: string,
): string | null {
  const normalizedRoute = route.trim();
  if (!normalizedRoute) {
    return null;
  }

  try {
    const baseUrl = resolvePanelUrlTemplate(panelType, namespacedType);
    const url = new URL(normalizedRoute, baseUrl);
    if (url.origin !== baseUrl.origin) {
      return null;
    }

    url.searchParams.set("atPopup", "1");
    url.searchParams.set("popupId", popupId);
    applyPanelAuth(url, panelType);
    return url.toString();
  } catch {
    return null;
  }
}

export function resolvePanelToolbarIconUrl(
  panelType: Pick<RuntimePanelType, "panelUrlTemplate">,
  iconPath: string,
): string | null {
  const normalizedPath = iconPath.trim();
  if (!normalizedPath) return null;

  try {
    return new URL(normalizedPath).toString();
  } catch {
    const origin = getModulePanelOrigin(panelType.panelUrlTemplate);
    if (!origin) return normalizedPath;
    return new URL(normalizedPath, `${origin}/`).toString();
  }
}

export function registerNativePanel(registration: NativePanelRegistration): void {
  nativePanels.set(registration.type, registration.component);
}

export function getNativePanelComponent(type: string): ComponentType<PanelProps> | undefined {
  return nativePanels.get(type);
}

export function useModuleRegistry(): ModuleRegistrySnapshot {
  return useSyncExternalStore(subscribe, getModuleRegistry, getModuleRegistry);
}

export function useCreatablePanelTypes(): RuntimePanelType[] {
  return useModuleRegistry().panelTypes;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function resolvePanelUrlTemplate(panelType: RuntimePanelType, namespacedType: string): URL {
  const baseUrl = panelType.panelUrlTemplate
    .split("{panel_type}")
    .join(encodeURIComponent(panelType.localType))
    .split("{namespaced_type}")
    .join(encodeURIComponent(namespacedType));
  return new URL(baseUrl);
}

export function withPanelAuth(url: string, panelType: Pick<RuntimePanelType, "authToken">): string {
  if (!panelType.authToken) return url;
  try {
    const nextUrl = new URL(url);
    applyPanelAuth(nextUrl, panelType);
    return nextUrl.toString();
  } catch {
    return url;
  }
}

function applyPanelAuth(url: URL, panelType: Pick<RuntimePanelType, "authToken">): void {
  if (panelType.authToken && !url.searchParams.has("atToken")) {
    url.searchParams.set("atToken", panelType.authToken);
  }
}
