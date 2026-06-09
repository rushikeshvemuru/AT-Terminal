import { BrowserPanel } from "@/components/panels/BrowserPanel";
import { LazyMonacoEditorPanel } from "@/components/panels/LazyMonacoEditorPanel";
import { BROWSER_PANEL_TYPE, MONACO_PANEL_TYPE, registerNativePanel } from "@/lib/panelRegistry";

registerNativePanel({
  type: MONACO_PANEL_TYPE,
  component: LazyMonacoEditorPanel,
});

registerNativePanel({
  type: BROWSER_PANEL_TYPE,
  component: BrowserPanel,
});
