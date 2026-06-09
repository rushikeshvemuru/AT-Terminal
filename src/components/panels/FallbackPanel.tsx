import { EMPTY_PANEL_TYPE } from "@/lib/panelRegistry";
import type { Panel } from "@/store/useTabStore";

interface FallbackPanelProps {
  panel: Panel;
  rootDirectory: string;
  onChangeType?: (type: string) => void;
}

/**
 * Fallback panel rendered when a panel type isn't registered.
 * Shows the unknown type name and offers to switch to a known type.
 */
export const FallbackPanel = ({ panel, onChangeType }: FallbackPanelProps) => {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded border border-zinc-800 bg-zinc-950 text-xs text-zinc-500">
      <span>Unknown panel type: {panel.type}</span>
      {onChangeType && (
        <button
          onClick={() => onChangeType(EMPTY_PANEL_TYPE)}
          className="rounded px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        >
          Switch to empty panel
        </button>
      )}
    </div>
  );
};
