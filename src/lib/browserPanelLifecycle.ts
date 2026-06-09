import { BROWSER_PANEL_TYPE } from "@/lib/panelRegistry";
import { closeBrowserPanelWindow } from "@/lib/browserPanel";
import type { Panel, Tab } from "@/store/useTabStore";

export async function closeBrowserPanelForPanel(panel: Pick<Panel, "id" | "type">): Promise<void> {
  if (panel.type !== BROWSER_PANEL_TYPE) {
    return;
  }

  try {
    await closeBrowserPanelWindow(panel.id);
  } catch (error) {
    console.error("Failed to close browser panel window:", error);
  }
}

export async function closeBrowserPanelsForTab(tab: Pick<Tab, "panels">): Promise<void> {
  await Promise.all(tab.panels.map((panel) => closeBrowserPanelForPanel(panel)));
}

export async function closeBrowserPanelsForTabs(tabs: Pick<Tab, "panels">[]): Promise<void> {
  await Promise.all(tabs.map((tab) => closeBrowserPanelsForTab(tab)));
}
