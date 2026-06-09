import { lazy, Suspense } from "react";
import type { PanelProps } from "@/lib/panelRegistry";

const MonacoEditorPanelLazy = lazy(() =>
  import("./MonacoEditorPanel").then((module) => ({
    default: module.MonacoEditorPanel,
  })),
);

export function LazyMonacoEditorPanel(props: PanelProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-black text-xs text-zinc-500">
          Loading editor...
        </div>
      }
    >
      <MonacoEditorPanelLazy {...props} />
    </Suspense>
  );
}
