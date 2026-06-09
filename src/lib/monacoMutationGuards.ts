import { MONACO_PANEL_TYPE } from "@/lib/panelRegistry";
import { usePanelGuardStore } from "@/store/usePanelGuardStore";
import { useTabStore } from "@/store/useTabStore";

interface MonacoPanelReference {
  tabId: string;
  panelId: string;
}

export interface MonacoMutationPlan {
  hasPanels: boolean;
  closePanels: () => void;
}

export async function prepareMonacoPanelsForPathRemoval(
  sessionId: string | null,
  paths: string[],
): Promise<MonacoMutationPlan | null> {
  const normalizedTargets = paths.map(normalizePath).filter(Boolean);
  if (!sessionId || normalizedTargets.length === 0) return createEmptyPlan();

  return prepareMonacoPanelMutation(sessionId, (filePath) => {
    const normalizedFilePath = normalizePath(filePath);
    return normalizedTargets.some((target) => isSameOrDescendant(target, normalizedFilePath));
  });
}

export async function prepareMonacoPanelsForRootMutation(
  sessionId: string | null,
  rootDirectory: string | null,
): Promise<MonacoMutationPlan | null> {
  if (!sessionId || !rootDirectory) return createEmptyPlan();
  const normalizedRoot = normalizePath(rootDirectory);

  return prepareMonacoPanelMutation(sessionId, (filePath) =>
    isSameOrDescendant(normalizedRoot, normalizePath(filePath)),
  );
}

async function prepareMonacoPanelMutation(
  sessionId: string,
  matchesPath: (filePath: string) => boolean,
): Promise<MonacoMutationPlan | null> {
  const panels = findMatchingMonacoPanels(sessionId, matchesPath);
  if (panels.length === 0) return createEmptyPlan();

  const { confirmPanelAction } = usePanelGuardStore.getState();
  for (const panel of panels) {
    const confirmed = await confirmPanelAction(panel.panelId, "close");
    if (!confirmed) return null;
  }

  return {
    hasPanels: true,
    closePanels: () => {
      const { removePanel } = useTabStore.getState();
      for (const panel of panels) {
        removePanel(sessionId, panel.tabId, panel.panelId);
      }
    },
  };
}

function findMatchingMonacoPanels(
  sessionId: string,
  matchesPath: (filePath: string) => boolean,
): MonacoPanelReference[] {
  const sessionState = useTabStore.getState().sessionStates[sessionId];
  if (!sessionState) return [];

  const matches: MonacoPanelReference[] = [];
  for (const tab of sessionState.tabs) {
    for (const panel of tab.panels) {
      if (panel.type !== MONACO_PANEL_TYPE) continue;
      const filePath = typeof panel.state?.filePath === "string" ? panel.state.filePath.trim() : "";
      if (!filePath || !matchesPath(filePath)) continue;
      matches.push({ tabId: tab.id, panelId: panel.id });
    }
  }
  return matches;
}

function createEmptyPlan(): MonacoMutationPlan {
  return {
    hasPanels: false,
    closePanels: () => {},
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSameOrDescendant(parentPath: string, targetPath: string): boolean {
  return targetPath === parentPath || targetPath.startsWith(`${parentPath}/`);
}
