import { create } from "zustand";
import type { TerminalBlockEvent, TerminalBlockSnapshot } from "@/lib/terminalBlocks";

interface TerminalBlockState {
  blocksByScope: Record<string, TerminalBlockSnapshot[]>;
  setBlocks: (scopeId: string, blocks: TerminalBlockSnapshot[]) => void;
  applyEvents: (events: TerminalBlockEvent[]) => void;
}

function upsertBlock(
  blocks: TerminalBlockSnapshot[],
  block: TerminalBlockSnapshot,
): TerminalBlockSnapshot[] {
  const index = blocks.findIndex((entry) => entry.id === block.id);
  if (index === -1) return [...blocks, block];
  const next = [...blocks];
  next[index] = block;
  return next;
}

export const useTerminalBlockStore = create<TerminalBlockState>((set) => ({
  blocksByScope: {},
  setBlocks: (scopeId, blocks) =>
    set((state) => ({
      blocksByScope: {
        ...state.blocksByScope,
        [scopeId]: blocks,
      },
    })),
  applyEvents: (events) => {
    if (events.length === 0) return;

    set((state) => {
      const nextBlocksByScope = { ...state.blocksByScope };

      for (const event of events) {
        const scopeBlocks = nextBlocksByScope[event.scopeId] ?? [];
        if (event.kind === "deleted") {
          nextBlocksByScope[event.scopeId] = scopeBlocks.filter(
            (block) => block.id !== event.blockId,
          );
          continue;
        }
        if (!event.block) continue;
        nextBlocksByScope[event.scopeId] = upsertBlock(scopeBlocks, event.block);
      }

      return { blocksByScope: nextBlocksByScope };
    });
  },
}));
