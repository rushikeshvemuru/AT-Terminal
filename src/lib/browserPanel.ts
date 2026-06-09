import { invoke } from "@tauri-apps/api/core";

export const BROWSER_PANEL_EVENT = "browser-panel-state-changed";
export const BROWSER_WINDOW_CLOSED_MESSAGE = "Browser window closed";

export interface BrowserPanelState {
  panelId: string;
  currentUrl: string;
  history: string[];
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError: string | null;
}

export function openBrowserPanelWindow(panelId: string, url?: string) {
  return invoke<BrowserPanelState>("open_browser_panel_window", { panelId, url });
}

export function navigateBrowserPanel(panelId: string, url: string) {
  return invoke<BrowserPanelState>("navigate_browser_panel", { panelId, url });
}

export function browserPanelGoBack(panelId: string) {
  return invoke<BrowserPanelState>("browser_panel_go_back", { panelId });
}

export function browserPanelGoForward(panelId: string) {
  return invoke<BrowserPanelState>("browser_panel_go_forward", { panelId });
}

export function browserPanelReload(panelId: string) {
  return invoke<BrowserPanelState>("browser_panel_reload", { panelId });
}

export function browserPanelStop(panelId: string) {
  return invoke<BrowserPanelState>("browser_panel_stop", { panelId });
}

export function focusBrowserPanelWindow(panelId: string) {
  return invoke<void>("focus_browser_panel_window", { panelId });
}

export function closeBrowserPanelWindow(panelId: string) {
  return invoke<void>("close_browser_panel_window", { panelId });
}

export function getBrowserPanelState(panelId: string) {
  return invoke<BrowserPanelState>("get_browser_panel_state", { panelId });
}
