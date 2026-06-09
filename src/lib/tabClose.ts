import { usePanelGuardStore } from "@/store/usePanelGuardStore";
import type { Tab } from "@/store/useTabStore";

type TabWithPanels = Pick<Tab, "panels">;

export async function confirmTabClose(tab: TabWithPanels): Promise<boolean> {
  const { confirmPanelAction } = usePanelGuardStore.getState();

  for (const panel of tab.panels) {
    const confirmed = await confirmPanelAction(panel.id, "close");
    if (!confirmed) {
      return false;
    }
  }

  return true;
}

export async function confirmTabsClose(tabs: TabWithPanels[]): Promise<boolean> {
  for (const tab of tabs) {
    const confirmed = await confirmTabClose(tab);
    if (!confirmed) {
      return false;
    }
  }

  return true;
}
