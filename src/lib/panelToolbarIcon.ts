import type { RuntimePanelType } from "@/lib/panelRegistry";
import { getModulePanelOrigin, resolvePanelToolbarIconUrl } from "@/lib/panelRegistry";

export interface ResolvedPanelToolbarIconSource {
  url: string;
  tintableSvg: boolean;
}

const moduleToolbarIconCacheBust = `${Date.now()}`;

export function resolvePanelToolbarIconSource(
  panelType: Pick<RuntimePanelType, "panelUrlTemplate">,
  iconPath: string,
): ResolvedPanelToolbarIconSource | null {
  const url = resolvePanelToolbarIconUrl(panelType, iconPath);
  if (!url) {
    return null;
  }

  const moduleOrigin = getModulePanelOrigin(panelType.panelUrlTemplate);
  if (!moduleOrigin) {
    return { url, tintableSvg: false };
  }

  try {
    const resolvedUrl = new URL(url);
    const tintableSvg =
      resolvedUrl.origin === moduleOrigin && resolvedUrl.pathname.toLowerCase().endsWith(".svg");
    if (tintableSvg) {
      resolvedUrl.searchParams.set("v", moduleToolbarIconCacheBust);
    }
    return {
      url: resolvedUrl.toString(),
      tintableSvg,
    };
  } catch {
    return { url, tintableSvg: false };
  }
}
