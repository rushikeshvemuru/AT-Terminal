import {
  FormEvent,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clipboard,
  Copy,
  FolderOpen,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveSessionId, useActiveTab } from "@/hooks/useActiveSessionTabState";
import {
  cancelTerminalBlock,
  deleteTerminalBlock,
  LAUNCHER_TERMINAL_BLOCK_SCOPE,
  listenTerminalBlockEvents,
  listTerminalBlocks,
  resizeInteractiveTerminalBlock,
  startTerminalBlock,
  startInteractiveTerminalBlock,
  type TerminalBlockEvent,
  type TerminalBlockSnapshot,
  writeInteractiveTerminalBlock,
} from "@/lib/terminalBlocks";
import { selectWorkspaceRoot } from "@/lib/workspaceRoots";
import { cn } from "@/lib/utils";
import { OVERLAY_Z_INDEX } from "@/lib/overlayLayers";
import { useConfirmationStore } from "@/store/useConfirmationStore";
import { useTerminalBlockStore } from "@/store/useTerminalBlockStore";

const EMPTY_BLOCKS: TerminalBlockSnapshot[] = [];
const EMPTY_BLOCK_IDS: string[] = [];
const BLOCK_TRANSCRIPT_SEPARATOR = "\n\n---\n\n";

interface TerminalBlockGroup {
  groupId: string;
  pages: TerminalBlockSnapshot[];
  activeIndex: number;
  activeBlock: TerminalBlockSnapshot;
}

function createBlockId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `block-${crypto.randomUUID()}`;
  }
  return `block-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function basename(path: string) {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() || path
  );
}

function formatDuration(startedAt: number, finishedAt: number | null, now: number) {
  const end = finishedAt ?? now;
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function statusLabel(block: TerminalBlockSnapshot) {
  if (block.status === "success") return block.exitCode === 0 ? "done" : `exit ${block.exitCode}`;
  if (block.status === "failed")
    return block.exitCode === null ? "failed" : `exit ${block.exitCode}`;
  return block.status;
}

function runGroupId(block: TerminalBlockSnapshot) {
  return block.runGroupId || block.id;
}

function runIndex(block: TerminalBlockSnapshot) {
  return block.runIndex || 1;
}

function blockTranscript(block: TerminalBlockSnapshot) {
  return [
    `Path: ${block.rootDirectory}`,
    `Command: ${block.command}`,
    `Run: ${runIndex(block)}`,
    `Status: ${statusLabel(block)}`,
    "",
    block.output || block.error || "No output",
  ].join("\n");
}

function elementContainsSelection(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.toString().length === 0) return false;

  const { anchorNode, focusNode } = selection;
  return Boolean(
    anchorNode && focusNode && element.contains(anchorNode) && element.contains(focusNode),
  );
}

function orderedSelectedBlocks(blocks: TerminalBlockSnapshot[], selectedIds: string[]) {
  const selected = new Set(selectedIds);
  return blocks.filter((block) => selected.has(block.id));
}

function createTerminalBlockGroups(
  blocks: TerminalBlockSnapshot[],
  activePageByGroupId: Record<string, string>,
): TerminalBlockGroup[] {
  const groups = new Map<string, TerminalBlockSnapshot[]>();
  const groupOrder: string[] = [];

  for (const block of blocks) {
    const groupId = runGroupId(block);
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
      groupOrder.push(groupId);
    }
    groups.get(groupId)?.push(block);
  }

  return groupOrder.flatMap((groupId) => {
    const pages = groups.get(groupId) ?? [];
    if (pages.length === 0) return [];
    const sortedPages = [...pages].sort((left, right) => {
      const indexDelta = runIndex(left) - runIndex(right);
      if (indexDelta !== 0) return indexDelta;
      return left.startedAt - right.startedAt;
    });
    const activeBlockId = activePageByGroupId[groupId];
    const requestedIndex = activeBlockId
      ? sortedPages.findIndex((block) => block.id === activeBlockId)
      : -1;
    const activeIndex = requestedIndex >= 0 ? requestedIndex : sortedPages.length - 1;
    const activeBlock = sortedPages[activeIndex];
    return [{ groupId, pages: sortedPages, activeIndex, activeBlock }];
  });
}

export const TerminalBlocksBar = () => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [runDirectoryDraft, setRunDirectoryDraft] = useState("");
  const [runInteractive, setRunInteractive] = useState(false);
  const [folderPicking, setFolderPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [collapsedById, setCollapsedById] = useState<Record<string, boolean>>({});
  const [selectedBlockIdsByScope, setSelectedBlockIdsByScope] = useState<Record<string, string[]>>(
    {},
  );
  const [lastSelectedBlockIdByScope, setLastSelectedBlockIdByScope] = useState<
    Record<string, string | null>
  >({});
  const [activePageByGroupId, setActivePageByGroupId] = useState<Record<string, string>>({});
  const [openContextMenuGroupId, setOpenContextMenuGroupId] = useState<string | null>(null);
  const [contextMenuResetKey, setContextMenuResetKey] = useState(0);
  const activeSessionId = useActiveSessionId();
  const activeTab = useActiveTab();
  const confirm = useConfirmationStore((state) => state.confirm);
  const scopeId = activeSessionId ?? LAUNCHER_TERMINAL_BLOCK_SCOPE;
  const rootDirectory = activeTab?.rootDirectory ?? null;
  const tabId = activeTab?.id ?? null;
  const blocks = useTerminalBlockStore((state) => state.blocksByScope[scopeId] ?? EMPTY_BLOCKS);
  const setBlocks = useTerminalBlockStore((state) => state.setBlocks);
  const applyEvents = useTerminalBlockStore((state) => state.applyEvents);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const lastRootDirectoryRef = useRef<string | null>(rootDirectory);
  const hasRunningBlocks = blocks.some((block) => block.status === "running");
  const blockGroups = useMemo(
    () => createTerminalBlockGroups(blocks, activePageByGroupId),
    [activePageByGroupId, blocks],
  );
  const visibleBlocks = useMemo(() => blockGroups.map((group) => group.activeBlock), [blockGroups]);
  const validSelectedIdsByScope = useMemo(() => {
    const availableIds = new Set(visibleBlocks.map((block) => block.id));
    return Object.fromEntries(
      Object.entries(selectedBlockIdsByScope).map(([key, ids]) => [
        key,
        ids.filter((blockId) => availableIds.has(blockId)),
      ]),
    );
  }, [selectedBlockIdsByScope, visibleBlocks]);
  const validatedLastSelectedBlockIdByScope = useMemo(() => {
    const availableIds = new Set(visibleBlocks.map((block) => block.id));
    const result: Record<string, string | null> = {};
    for (const [key, id] of Object.entries(lastSelectedBlockIdByScope)) {
      result[key] = id && availableIds.has(id) ? id : null;
    }
    return result;
  }, [lastSelectedBlockIdByScope, visibleBlocks]);
  const selectedBlockIdsForScope = validSelectedIdsByScope[scopeId] ?? EMPTY_BLOCK_IDS;
  const selectedBlockIds = useMemo(() => {
    const availableIds = new Set(visibleBlocks.map((block) => block.id));
    return selectedBlockIdsForScope.filter((blockId) => availableIds.has(blockId));
  }, [selectedBlockIdsForScope, visibleBlocks]);
  const selectedBlocks = useMemo(
    () => orderedSelectedBlocks(visibleBlocks, selectedBlockIds),
    [selectedBlockIds, visibleBlocks],
  );
  const scopeHint = activeTab?.name ?? (rootDirectory ? basename(rootDirectory) : "Default shell");

  if (lastRootDirectoryRef.current !== rootDirectory) {
    lastRootDirectoryRef.current = rootDirectory;
    setRunDirectoryDraft(rootDirectory ?? "");
  }

  useEffect(() => {
    let disposed = false;
    let unlistenEvents: (() => void) | null = null;
    const pendingEvents: TerminalBlockEvent[] = [];

    const flushEvents = () => {
      flushTimerRef.current = null;
      const events = pendingEvents.splice(0);
      if (events.length > 0) {
        applyEvents(events);
      }
    };

    const setup = async () => {
      const unlisten = await listenTerminalBlockEvents((event) => {
        if (disposed) return;
        pendingEvents.push(event);
        if (!flushTimerRef.current) {
          flushTimerRef.current = window.setTimeout(flushEvents, 50);
        }
      });

      if (disposed) {
        unlisten();
      } else {
        unlistenEvents = unlisten;
      }
    };

    void setup().catch((listenError) => {
      console.error("Failed to listen for terminal block events:", listenError);
    });

    return () => {
      disposed = true;
      if (flushTimerRef.current) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      const events = pendingEvents.splice(0);
      if (events.length > 0) {
        applyEvents(events);
      }
      unlistenEvents?.();
    };
  }, [applyEvents]);

  useEffect(() => {
    let cancelled = false;
    void listTerminalBlocks(scopeId)
      .then((nextBlocks) => {
        if (!cancelled) setBlocks(scopeId, nextBlocks);
      })
      .catch((loadError) => {
        if (!cancelled) {
          console.error("Failed to load terminal blocks:", loadError);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scopeId, setBlocks]);

  useEffect(() => {
    if (!hasRunningBlocks) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningBlocks]);

  useEffect(() => {
    if (!open) return;
    const scrollToBottom = () => {
      outputRef.current?.scrollTo({
        top: outputRef.current.scrollHeight,
        behavior: "auto",
      });
    };

    scrollToBottom();
    let secondFrame: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(scrollToBottom);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [blocks, open]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const command = draft.trim();
    if (!command || submitting) return;

    const blockId = createBlockId();
    const runDirectory = runDirectoryDraft.trim() || null;
    const runBlock = runInteractive
      ? startInteractiveTerminalBlock({
          scopeId,
          blockId,
          command,
          rootDirectory: runDirectory,
          tabId,
          runGroupId: blockId,
          runIndex: 1,
          cols: 80,
          rows: 14,
        })
      : startTerminalBlock({
          scopeId,
          blockId,
          command,
          rootDirectory: runDirectory,
          tabId,
          runGroupId: blockId,
          runIndex: 1,
        });

    setSubmitting(true);
    setError(null);
    void runBlock
      .then((block) => {
        applyEvents([{ kind: "started", scopeId, blockId, block }]);
        setDraft("");
        setOpen(true);
      })
      .catch((startError) => {
        setError(String(startError));
      })
      .finally(() => setSubmitting(false));
  };

  const handlePickRunDirectory = () => {
    if (folderPicking) return;

    setFolderPicking(true);
    setError(null);
    void selectWorkspaceRoot("Run Command In")
      .then((selected) => {
        if (selected?.path) {
          setRunDirectoryDraft(selected.path);
        }
      })
      .catch((pickError) => {
        setError(`Could not open folder picker: ${String(pickError)}`);
      })
      .finally(() => setFolderPicking(false));
  };

  const nextRunIndexForGroup = (groupId: string) =>
    blocks
      .filter((block) => runGroupId(block) === groupId)
      .reduce((maxIndex, block) => Math.max(maxIndex, runIndex(block)), 0) + 1;

  const handleCancel = (blockId: string) => {
    setError(null);
    void cancelTerminalBlock(blockId).catch((cancelError) => {
      setError(String(cancelError));
    });
  };

  const handleCopy = (value: string) => {
    setError(null);
    void navigator.clipboard.writeText(value).catch((copyError) => {
      setError(`Failed to copy: ${String(copyError)}`);
    });
  };

  const clearGroupUiState = (groupId: string) => {
    setActivePageByGroupId((current) => {
      const { [groupId]: _removed, ...next } = current;
      return next;
    });
    setCollapsedById((current) => {
      const { [groupId]: _removed, ...next } = current;
      return next;
    });
  };

  const handleRerun = (block: TerminalBlockSnapshot) => {
    const blockId = createBlockId();
    const groupId = runGroupId(block);
    setError(null);
    void startTerminalBlock({
      scopeId,
      blockId,
      command: block.command,
      rootDirectory: block.rootDirectory,
      tabId: block.tabId,
      runGroupId: groupId,
      runIndex: nextRunIndexForGroup(groupId),
    })
      .then((nextBlock) => {
        applyEvents([{ kind: "started", scopeId, blockId, block: nextBlock }]);
        setActivePageByGroupId((current) => ({
          ...current,
          [groupId]: nextBlock.id,
        }));
        setOpen(true);
      })
      .catch((rerunError) => {
        setError(String(rerunError));
      });
  };

  const handleInteractiveRerun = (block: TerminalBlockSnapshot) => {
    const blockId = createBlockId();
    const groupId = runGroupId(block);
    setError(null);
    void startInteractiveTerminalBlock({
      scopeId,
      blockId,
      command: block.command,
      rootDirectory: block.rootDirectory,
      tabId: block.tabId,
      runGroupId: groupId,
      runIndex: nextRunIndexForGroup(groupId),
      cols: 80,
      rows: 14,
      seedOutput: block.output,
    })
      .then((nextBlock) => {
        applyEvents([{ kind: "started", scopeId, blockId, block: nextBlock }]);
        setActivePageByGroupId((current) => ({
          ...current,
          [groupId]: nextBlock.id,
        }));
        setOpen(true);
      })
      .catch((rerunError) => {
        setError(String(rerunError));
      });
  };

  const handleInteractiveInput = (blockId: string, input: string) => {
    void writeInteractiveTerminalBlock(blockId, input).catch((inputError) => {
      setError(String(inputError));
    });
  };

  const handleInteractiveResize = (blockId: string, cols: number, rows: number) => {
    void resizeInteractiveTerminalBlock(blockId, cols, rows).catch((resizeError) => {
      setError(String(resizeError));
    });
  };

  const handleDeleteCard = (block: TerminalBlockSnapshot) => {
    setError(null);
    void (async () => {
      const running = block.status === "running";
      const confirmed = await confirm({
        title: running ? "Cancel and delete card?" : "Delete terminal card?",
        description: running
          ? "This will cancel the running command and remove this card from the current in-memory history."
          : "This will remove this card from the current in-memory history.",
        confirmLabel: running ? "Cancel and Delete" : "Delete",
        cancelLabel: "Keep",
        variant: "warning",
        destructive: true,
      });
      if (!confirmed) return;
      await deleteTerminalBlock(block.id);
    })().catch((deleteError) => {
      setError(String(deleteError));
    });
  };

  const handleDeleteBlock = (group: TerminalBlockGroup) => {
    setError(null);
    void (async () => {
      const runningCount = group.pages.filter((page) => page.status === "running").length;
      const cardCount = group.pages.length;
      const confirmed = await confirm({
        title: runningCount > 0 ? "Cancel and delete block?" : "Delete terminal block?",
        description:
          runningCount > 0
            ? `This will cancel ${runningCount} running ${
                runningCount === 1 ? "card" : "cards"
              } and remove all ${cardCount} ${
                cardCount === 1 ? "card" : "cards"
              } in this terminal block from the current in-memory history.`
            : `This will remove all ${cardCount} ${
                cardCount === 1 ? "card" : "cards"
              } in this terminal block from the current in-memory history.`,
        confirmLabel: runningCount > 0 ? "Cancel and Delete" : "Delete",
        cancelLabel: "Keep",
        variant: "warning",
        destructive: true,
      });
      if (!confirmed) return;
      await Promise.all(group.pages.map((page) => deleteTerminalBlock(page.id)));
      clearGroupUiState(group.groupId);
    })().catch((deleteError) => {
      setError(String(deleteError));
    });
  };

  const handleDeleteAllBlocks = () => {
    if (blocks.length === 0) return;

    setError(null);
    void (async () => {
      const runningCount = blocks.filter((block) => block.status === "running").length;
      const blockCount = blockGroups.length;
      const runCount = blocks.length;
      const confirmed = await confirm({
        title: runningCount > 0 ? "Cancel and delete all blocks?" : "Delete all blocks?",
        description:
          runningCount > 0
            ? `This will cancel ${runningCount} running ${
                runningCount === 1 ? "run" : "runs"
              } and remove ${blockCount} ${blockCount === 1 ? "block" : "blocks"} / ${runCount} ${
                runCount === 1 ? "run" : "runs"
              } from the current in-memory history.`
            : `This will remove ${blockCount} ${
                blockCount === 1 ? "block" : "blocks"
              } / ${runCount} ${
                runCount === 1 ? "run" : "runs"
              } from the current in-memory history.`,
        confirmLabel: runningCount > 0 ? "Cancel and Delete" : "Delete All",
        cancelLabel: "Keep",
        variant: "warning",
        destructive: true,
      });
      if (!confirmed) return;

      await Promise.all(blocks.map((block) => deleteTerminalBlock(block.id)));
      setSelectedBlockIdsByScope((current) => ({
        ...current,
        [scopeId]: [],
      }));
      setLastSelectedBlockIdByScope((current) => ({
        ...current,
        [scopeId]: null,
      }));
      setActivePageByGroupId({});
      setCollapsedById({});
    })().catch((deleteError) => {
      setError(String(deleteError));
    });
  };

  const selectBlockRange = (fromBlockId: string, toBlockId: string) => {
    const from = visibleBlocks.findIndex((block) => block.id === fromBlockId);
    const to = visibleBlocks.findIndex((block) => block.id === toBlockId);
    if (from === -1 || to === -1) return [toBlockId];
    const [start, end] = from < to ? [from, to] : [to, from];
    return visibleBlocks.slice(start, end + 1).map((block) => block.id);
  };

  const handleSelectBlock = (blockId: string, options: { range?: boolean; toggle?: boolean }) => {
    const lastSelectedBlockId = validatedLastSelectedBlockIdByScope[scopeId] ?? null;
    let nextSelectedIds: string[];

    if (options.range && lastSelectedBlockId) {
      nextSelectedIds = selectBlockRange(lastSelectedBlockId, blockId);
    } else if (options.toggle) {
      nextSelectedIds = selectedBlockIds.includes(blockId)
        ? selectedBlockIds.filter((selectedBlockId) => selectedBlockId !== blockId)
        : [...selectedBlockIds, blockId];
    } else {
      nextSelectedIds = [blockId];
    }

    setSelectedBlockIdsByScope((current) => ({
      ...current,
      [scopeId]: nextSelectedIds,
    }));
    setLastSelectedBlockIdByScope((current) => ({
      ...current,
      [scopeId]: blockId,
    }));
  };

  const handleContextSelectBlock = (blockId: string) => {
    if (selectedBlockIds.includes(blockId)) return;
    handleSelectBlock(blockId, {});
  };

  const closeTerminalBlockContextMenu = () => {
    if (openContextMenuGroupId === null) return;
    setOpenContextMenuGroupId(null);
    setContextMenuResetKey((current) => current + 1);
  };

  const handlePopoverPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-terminal-block-context-menu-content]")) return;
    closeTerminalBlockContextMenu();
  };

  const handleClearSelection = () => {
    setSelectedBlockIdsByScope((current) => ({
      ...current,
      [scopeId]: [],
    }));
    setLastSelectedBlockIdByScope((current) => ({
      ...current,
      [scopeId]: null,
    }));
  };

  const focusBlock = (blockId: string) => {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-terminal-block-id="${blockId}"]`)?.focus();
    });
  };

  const handleNavigateBlock = (blockId: string, delta: number, extendSelection: boolean) => {
    const currentIndex = visibleBlocks.findIndex((block) => block.id === blockId);
    const nextBlock = visibleBlocks[currentIndex + delta];
    if (!nextBlock) return;
    if (extendSelection) {
      handleSelectBlock(nextBlock.id, { range: true });
    }
    focusBlock(nextBlock.id);
  };

  const handleBulkCopy = (value: string) => {
    if (!value) return;
    handleCopy(value);
  };

  const handleBulkRerun = () => {
    setError(null);
    void (async () => {
      for (const block of selectedBlocks) {
        const blockId = createBlockId();
        const groupId = runGroupId(block);
        const nextBlock = await startTerminalBlock({
          scopeId,
          blockId,
          command: block.command,
          rootDirectory: block.rootDirectory,
          tabId: block.tabId,
          runGroupId: groupId,
          runIndex: nextRunIndexForGroup(groupId),
        });
        applyEvents([{ kind: "started", scopeId, blockId, block: nextBlock }]);
        setActivePageByGroupId((current) => ({
          ...current,
          [groupId]: nextBlock.id,
        }));
      }
      handleClearSelection();
      setOpen(true);
    })().catch((rerunError) => {
      setError(String(rerunError));
    });
  };

  const handleBulkDelete = () => {
    setError(null);
    void (async () => {
      const runningCount = selectedBlocks.filter((block) => block.status === "running").length;
      const confirmed = await confirm({
        title: runningCount > 0 ? "Cancel and delete selected cards?" : "Delete selected cards?",
        description:
          runningCount > 0
            ? `This will cancel ${runningCount} running ${
                runningCount === 1 ? "card" : "cards"
              } and remove ${selectedBlocks.length} selected ${
                selectedBlocks.length === 1 ? "card" : "cards"
              } from the current in-memory history.`
            : `This will remove ${selectedBlocks.length} selected ${
                selectedBlocks.length === 1 ? "card" : "cards"
              } from the current in-memory history.`,
        confirmLabel: runningCount > 0 ? "Cancel and Delete" : "Delete",
        cancelLabel: "Keep",
        variant: "warning",
        destructive: true,
      });
      if (!confirmed) return;
      await Promise.all(selectedBlocks.map((block) => deleteTerminalBlock(block.id)));
      handleClearSelection();
    })().catch((deleteError) => {
      setError(String(deleteError));
    });
  };

  const handleChangePage = (group: TerminalBlockGroup, delta: number) => {
    const nextIndex = group.activeIndex + delta;
    const nextBlock = group.pages[nextIndex];
    if (!nextBlock) return;
    setActivePageByGroupId((current) => ({
      ...current,
      [group.groupId]: nextBlock.id,
    }));
  };

  const handleToggleCollapse = (blockId: string) => {
    setCollapsedById((current) => ({
      ...current,
      [blockId]: !current[blockId],
    }));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {openContextMenuGroupId
        ? createPortal(
            <div
              className="fixed inset-0"
              style={{ zIndex: OVERLAY_Z_INDEX.floatingMenuBackdrop }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                closeTerminalBlockContextMenu();
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.button === 2) {
                  return;
                }
                closeTerminalBlockContextMenu();
              }}
              onWheel={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            />,
            document.body,
          )
        : null}
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          className="flex h-5 w-[min(44vw,22rem)] min-w-[13rem] items-center overflow-hidden rounded border border-zinc-800 bg-black/80 shadow-sm shadow-black/30"
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex h-full w-7 shrink-0 items-center justify-center border-r border-zinc-800 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200",
                open && "bg-zinc-900 text-zinc-200",
              )}
              title="Expand terminal blocks"
              aria-label="Expand terminal blocks"
              aria-expanded={open}
            >
              <ChevronUp className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            </button>
          </PopoverTrigger>

          <form onSubmit={handleSubmit} className="flex h-full min-w-0 flex-1 items-center">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Run command..."
              disabled={submitting}
              className="h-full min-w-0 flex-1 bg-transparent px-2 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 disabled:cursor-wait disabled:opacity-70"
              aria-label="Terminal block command"
            />
            <button
              type="button"
              onClick={() => setRunInteractive((current) => !current)}
              aria-pressed={runInteractive}
              className={cn(
                "flex h-full w-7 shrink-0 items-center justify-center border-l border-zinc-900 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200",
                runInteractive && "bg-zinc-900 text-sky-300 hover:text-sky-200",
              )}
              title={
                runInteractive
                  ? "Run commands in interactive terminal mode"
                  : "Run commands in captured mode"
              }
              aria-label="Toggle interactive terminal block mode"
            >
              <Terminal className="h-3 w-3" />
            </button>
            <button
              type="submit"
              disabled={!draft.trim() || submitting}
              className="flex h-full w-7 shrink-0 items-center justify-center border-l border-zinc-900 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-45"
              title="Run terminal block"
              aria-label="Run terminal block"
            >
              {submitting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3 fill-current" />
              )}
            </button>
          </form>
        </div>
      </PopoverAnchor>

      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        className="w-[min(72vw,38rem)] min-w-[22rem] border-zinc-800 bg-zinc-950 p-0 text-zinc-100 shadow-lg shadow-black/40"
        onInteractOutside={(event) => {
          const target = event.target as Node | null;
          if (target && anchorRef.current?.contains(target)) {
            event.preventDefault();
          }
        }}
      >
        <div
          className="flex max-h-[min(60vh,32rem)] flex-col"
          onPointerDownCapture={handlePopoverPointerDownCapture}
        >
          <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
            <div className="min-w-[7.5rem] shrink-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Terminal Blocks
              </p>
              <p className="truncate text-xs text-zinc-400">{scopeHint}</p>
            </div>
            <div className="h-7 w-px shrink-0 bg-zinc-800" />
            <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded border border-zinc-800 bg-black/30">
              <button
                type="button"
                onClick={handlePickRunDirectory}
                disabled={folderPicking}
                className="flex h-7 w-7 shrink-0 items-center justify-center border-r border-zinc-800 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-wait disabled:opacity-50"
                title="Pick run directory"
                aria-label="Pick run directory"
              >
                {folderPicking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5" />
                )}
              </button>
              <input
                type="text"
                value={runDirectoryDraft}
                onChange={(event) => setRunDirectoryDraft(event.target.value)}
                placeholder="Run directory..."
                className="h-7 min-w-0 flex-1 bg-transparent px-2 font-mono text-[11px] text-zinc-300 outline-none placeholder:text-zinc-600"
                aria-label="Terminal block run directory"
              />
            </div>
            <div className="h-7 w-px shrink-0 bg-zinc-800" />
            <button
              type="button"
              onClick={handleDeleteAllBlocks}
              disabled={blocks.length === 0}
              className="shrink-0 rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 transition-colors hover:border-red-900/70 hover:bg-red-950/40 hover:text-red-300 focus:border-red-900/70 focus:bg-red-950/40 focus:text-red-300 disabled:cursor-not-allowed disabled:hover:border-zinc-800 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
              title="Delete all terminal blocks"
              aria-label="Delete all terminal blocks"
            >
              {blockGroups.length} {blockGroups.length === 1 ? "block" : "blocks"}
            </button>
          </div>

          {selectedBlocks.length > 0 && (
            <TerminalBlockSelectionToolbar
              selectedBlocks={selectedBlocks}
              onClear={handleClearSelection}
              onCopyBlocks={() =>
                handleBulkCopy(selectedBlocks.map(blockTranscript).join(BLOCK_TRANSCRIPT_SEPARATOR))
              }
              onCopyCommands={() =>
                handleBulkCopy(selectedBlocks.map((block) => block.command).join("\n"))
              }
              onCopyOutputs={() =>
                handleBulkCopy(
                  selectedBlocks.map((block) => block.output).join(BLOCK_TRANSCRIPT_SEPARATOR),
                )
              }
              onDelete={handleBulkDelete}
              onRerun={handleBulkRerun}
            />
          )}

          <div
            ref={outputRef}
            role="listbox"
            aria-label="Terminal blocks"
            aria-multiselectable="true"
            className="min-h-0 flex-1 snap-y snap-mandatory space-y-2 overflow-y-auto py-2 pl-2 pr-3 [scroll-padding-bottom:0.5rem] [scrollbar-gutter:stable]"
          >
            {blockGroups.length === 0 ? (
              <div className="rounded border border-dashed border-zinc-800 px-3 py-6 text-center text-xs text-zinc-500">
                Run a command to create the first terminal block.
              </div>
            ) : (
              blockGroups.map((group) => (
                <TerminalBlockContextMenu
                  key={group.groupId}
                  group={group}
                  collapsed={Boolean(collapsedById[group.groupId])}
                  resetKey={contextMenuResetKey}
                  selected={selectedBlockIds.includes(group.activeBlock.id)}
                  selectedBlocks={selectedBlocks}
                  onChangePage={() => handleChangePage(group, -1)}
                  onClearSelection={handleClearSelection}
                  onCloseContextMenu={closeTerminalBlockContextMenu}
                  onContextSelect={handleContextSelectBlock}
                  onCopy={handleCopy}
                  onDeleteBlock={handleDeleteBlock}
                  onDeleteCard={handleDeleteCard}
                  onOpenChange={(nextOpen) => {
                    setOpenContextMenuGroupId(nextOpen ? group.groupId : null);
                  }}
                  onBulkCopy={handleBulkCopy}
                  onBulkDelete={handleBulkDelete}
                  onBulkRerun={handleBulkRerun}
                  onNextPage={() => handleChangePage(group, 1)}
                  onInteractiveRerun={handleInteractiveRerun}
                  onRerun={handleRerun}
                  onToggleCollapse={handleToggleCollapse}
                >
                  <TerminalBlockCard
                    block={group.activeBlock}
                    groupId={group.groupId}
                    pageIndex={group.activeIndex}
                    pageCount={group.pages.length}
                    collapsed={Boolean(collapsedById[group.groupId])}
                    selected={selectedBlockIds.includes(group.activeBlock.id)}
                    now={now}
                    onCancel={handleCancel}
                    onChangePage={() => handleChangePage(group, -1)}
                    onCopy={handleCopy}
                    onDeleteCard={handleDeleteCard}
                    onNavigate={handleNavigateBlock}
                    onNextPage={() => handleChangePage(group, 1)}
                    onInteractiveInput={handleInteractiveInput}
                    onInteractiveRerun={handleInteractiveRerun}
                    onInteractiveResize={handleInteractiveResize}
                    onRerun={handleRerun}
                    onSelect={handleSelectBlock}
                    onClearSelection={handleClearSelection}
                    onCloseContextMenu={closeTerminalBlockContextMenu}
                    onToggleCollapse={handleToggleCollapse}
                  />
                </TerminalBlockContextMenu>
              ))
            )}
          </div>

          {error && (
            <div className="border-t border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

interface TerminalBlockCardProps extends Omit<HTMLAttributes<HTMLElement>, "onCopy" | "onSelect"> {
  block: TerminalBlockSnapshot;
  groupId: string;
  pageIndex: number;
  pageCount: number;
  collapsed: boolean;
  selected: boolean;
  now: number;
  onCancel: (blockId: string) => void;
  onChangePage: () => void;
  onCopy: (value: string) => void;
  onDeleteCard: (block: TerminalBlockSnapshot) => void;
  onInteractiveInput: (blockId: string, input: string) => void;
  onInteractiveRerun: (block: TerminalBlockSnapshot) => void;
  onInteractiveResize: (blockId: string, cols: number, rows: number) => void;
  onNavigate: (blockId: string, delta: number, extendSelection: boolean) => void;
  onNextPage: () => void;
  onRerun: (block: TerminalBlockSnapshot) => void;
  onSelect: (blockId: string, options: { range?: boolean; toggle?: boolean }) => void;
  onClearSelection: () => void;
  onCloseContextMenu: () => void;
  onToggleCollapse: (blockId: string) => void;
}

interface TerminalBlockContextMenuProps {
  group: TerminalBlockGroup;
  collapsed: boolean;
  resetKey: number;
  selected: boolean;
  selectedBlocks: TerminalBlockSnapshot[];
  children: ReactNode;
  onBulkCopy: (value: string) => void;
  onBulkDelete: () => void;
  onBulkRerun: () => void;
  onChangePage: () => void;
  onClearSelection: () => void;
  onCloseContextMenu: () => void;
  onContextSelect: (blockId: string) => void;
  onCopy: (value: string) => void;
  onDeleteBlock: (group: TerminalBlockGroup) => void;
  onDeleteCard: (block: TerminalBlockSnapshot) => void;
  onNextPage: () => void;
  onOpenChange: (open: boolean) => void;
  onInteractiveRerun: (block: TerminalBlockSnapshot) => void;
  onRerun: (block: TerminalBlockSnapshot) => void;
  onToggleCollapse: (blockId: string) => void;
}

function TerminalBlockContextMenu({
  group,
  collapsed,
  resetKey,
  selected,
  selectedBlocks,
  children,
  onBulkCopy,
  onBulkDelete,
  onBulkRerun,
  onChangePage,
  onClearSelection,
  onCloseContextMenu,
  onContextSelect,
  onCopy,
  onDeleteBlock,
  onDeleteCard,
  onNextPage,
  onOpenChange,
  onInteractiveRerun,
  onRerun,
  onToggleCollapse,
}: TerminalBlockContextMenuProps) {
  const block = group.activeBlock;
  const useBulkActions = selected && selectedBlocks.length > 1;
  const runningCount = selectedBlocks.filter(
    (selectedBlock) => selectedBlock.status === "running",
  ).length;
  const selectedCount = selectedBlocks.length;

  const copySelectedBlocks = () =>
    onBulkCopy(selectedBlocks.map(blockTranscript).join(BLOCK_TRANSCRIPT_SEPARATOR));
  const copySelectedCommands = () =>
    onBulkCopy(selectedBlocks.map((selectedBlock) => selectedBlock.command).join("\n"));
  const copySelectedOutputs = () =>
    onBulkCopy(
      selectedBlocks.map((selectedBlock) => selectedBlock.output).join(BLOCK_TRANSCRIPT_SEPARATOR),
    );

  return (
    <ContextMenu
      modal={false}
      key={`${group.groupId}:${resetKey}`}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onContextSelect(block.id);
        onOpenChange(nextOpen);
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        data-terminal-block-context-menu-content
        className="min-w-[210px] text-xs"
      >
        {useBulkActions ? (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
              {selectedCount} selected
            </div>
            <TerminalBlockContextMenuItem onSelect={copySelectedBlocks}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy Selected Cards
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem onSelect={copySelectedCommands}>
              <Terminal className="mr-2 h-3.5 w-3.5" />
              Copy Selected Commands
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem onSelect={copySelectedOutputs}>
              <Clipboard className="mr-2 h-3.5 w-3.5" />
              Copy Selected Outputs
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuSeparator />
            <TerminalBlockContextMenuItem onSelect={onBulkRerun}>
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
              Rerun Selected Cards
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem
              onSelect={() => {
                onClearSelection();
                onCloseContextMenu();
              }}
            >
              <X className="mr-2 h-3.5 w-3.5" />
              Clear Selection
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuSeparator />
            <TerminalBlockContextMenuItem destructive onSelect={onBulkDelete}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {runningCount > 0 ? "Cancel and Delete Selected Cards" : "Delete Selected Cards"}
            </TerminalBlockContextMenuItem>
          </>
        ) : (
          <>
            <div className="max-w-[17rem] truncate px-2 py-1 font-mono text-[10px] text-zinc-500">
              {block.command}
            </div>
            <TerminalBlockContextMenuItem onSelect={() => onCopy(blockTranscript(block))}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy Card
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem onSelect={() => onCopy(block.command)}>
              <Terminal className="mr-2 h-3.5 w-3.5" />
              Copy Command
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem onSelect={() => onCopy(block.output)}>
              <Clipboard className="mr-2 h-3.5 w-3.5" />
              Copy Output
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuSeparator />
            <TerminalBlockContextMenuItem onSelect={() => onRerun(block)}>
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
              Rerun Card
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem onSelect={() => onInteractiveRerun(block)}>
              <Terminal className="mr-2 h-3.5 w-3.5" />
              Interactive Rerun Card
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem onSelect={() => onToggleCollapse(group.groupId)}>
              <ChevronRight
                className={cn("mr-2 h-3.5 w-3.5 transition-transform", !collapsed && "rotate-90")}
              />
              {collapsed ? "Expand" : "Collapse"}
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuSeparator />
            <TerminalBlockContextMenuItem disabled={group.activeIndex <= 0} onSelect={onChangePage}>
              <ChevronLeft className="mr-2 h-3.5 w-3.5" />
              Previous Run
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem
              disabled={group.activeIndex >= group.pages.length - 1}
              onSelect={onNextPage}
            >
              <ChevronRight className="mr-2 h-3.5 w-3.5" />
              Next Run
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuSeparator />
            <TerminalBlockContextMenuItem destructive onSelect={() => onDeleteCard(block)}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete Card
            </TerminalBlockContextMenuItem>
            <TerminalBlockContextMenuItem destructive onSelect={() => onDeleteBlock(group)}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete Block
            </TerminalBlockContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface TerminalBlockContextMenuItemProps {
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

function TerminalBlockContextMenuItem({
  children,
  destructive = false,
  disabled = false,
  onSelect,
}: TerminalBlockContextMenuItemProps) {
  return (
    <ContextMenuItem
      disabled={disabled}
      onSelect={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className={cn(
        "text-xs",
        destructive && "text-red-400 focus:bg-red-950/40 focus:text-red-300",
      )}
    >
      {children}
    </ContextMenuItem>
  );
}

function TerminalBlockContextMenuSeparator() {
  return <div className="my-1 h-px bg-zinc-800" />;
}

const TerminalBlockCard = forwardRef<HTMLElement, TerminalBlockCardProps>(
  function TerminalBlockCard(
    {
      block,
      groupId,
      pageIndex,
      pageCount,
      collapsed,
      selected,
      now,
      onCancel,
      onChangePage,
      onClick,
      onCopy,
      onDeleteCard,
      onInteractiveInput,
      onInteractiveRerun,
      onInteractiveResize,
      onKeyDown,
      onNavigate,
      onNextPage,
      onRerun,
      onSelect,
      onClearSelection,
      onCloseContextMenu,
      onToggleCollapse,
      className,
      ...sectionProps
    },
    ref,
  ) {
    const running = block.status === "running";

    const handleClick = (event: MouseEvent<HTMLElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      onCloseContextMenu();
      const target = event.target as HTMLElement;
      const hasTextSelection = window.getSelection()?.toString();
      if (target.closest("button") || (target.closest("pre") && hasTextSelection)) return;
      onSelect(block.id, {
        range: event.shiftKey,
        toggle: event.metaKey || event.ctrlKey,
      });
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target.closest("button")) return;

      switch (event.key) {
        case " ":
        case "Enter":
          event.preventDefault();
          onSelect(block.id, {
            toggle: event.metaKey || event.ctrlKey,
          });
          return;
        case "ArrowDown":
          event.preventDefault();
          onNavigate(block.id, 1, event.shiftKey);
          return;
        case "ArrowUp":
          event.preventDefault();
          onNavigate(block.id, -1, event.shiftKey);
          return;
        case "Escape":
          event.preventDefault();
          onClearSelection();
          return;
        default:
          return;
      }
    };

    const handleOutputContextMenu = (event: MouseEvent<HTMLPreElement>) => {
      if (!elementContainsSelection(event.currentTarget)) return;
      onCloseContextMenu();
      event.stopPropagation();
    };

    return (
      <section
        ref={ref}
        {...sectionProps}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        data-terminal-block-id={block.id}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          "snap-end scroll-mb-2 overflow-hidden rounded border bg-black/50 outline-none transition-colors",
          selected
            ? "border-sky-700/70 bg-sky-950/15 ring-1 ring-sky-900/50"
            : "border-zinc-800 focus:border-zinc-600 focus:ring-1 focus:ring-zinc-700/70",
          className,
        )}
      >
        <div
          className={cn(
            "flex min-h-7 items-center gap-2 border-b px-2",
            selected ? "border-sky-900/50 bg-sky-950/20" : "border-zinc-800 bg-zinc-950/90",
          )}
        >
          <button
            type="button"
            onClick={() => onToggleCollapse(groupId)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title={collapsed ? "Expand block" : "Collapse block"}
            aria-label={collapsed ? "Expand block" : "Collapse block"}
            aria-expanded={!collapsed}
          >
            <ChevronRight
              className={cn("h-3.5 w-3.5 transition-transform", !collapsed && "rotate-90")}
            />
          </button>
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              block.status === "running" && "bg-sky-400",
              block.status === "success" && "bg-emerald-400",
              block.status === "failed" && "bg-red-400",
              block.status === "cancelled" && "bg-amber-400",
            )}
          />
          <code className="min-w-0 flex-1 truncate text-[11px] text-zinc-200">{block.command}</code>
          <span className="flex shrink-0 items-center rounded border border-zinc-800 bg-black/30 text-[10px] text-zinc-500">
            <TerminalBlockPageButton
              title="Previous run"
              ariaLabel="Show previous run"
              disabled={pageIndex <= 0}
              onClick={onChangePage}
            >
              <ChevronLeft className="h-3 w-3" />
            </TerminalBlockPageButton>
            <span className="min-w-7 px-1 text-center tabular-nums text-zinc-400">
              {pageIndex + 1}/{pageCount}
            </span>
            <TerminalBlockPageButton
              title="Next run"
              ariaLabel="Show next run"
              disabled={pageIndex >= pageCount - 1}
              onClick={onNextPage}
            >
              <ChevronRight className="h-3 w-3" />
            </TerminalBlockPageButton>
          </span>
          <span
            className={cn(
              "shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              block.status === "running" && "border-sky-900/80 text-sky-300",
              block.status === "success" && "border-emerald-900/80 text-emerald-300",
              block.status === "failed" && "border-red-900/80 text-red-300",
              block.status === "cancelled" && "border-amber-900/80 text-amber-300",
            )}
          >
            {statusLabel(block)}
          </span>
          <span className="shrink-0 text-[10px] text-zinc-600">
            {formatDuration(block.startedAt, block.finishedAt, now)}
          </span>
          {running && (
            <button
              type="button"
              onClick={() => onCancel(block.id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-300"
              title="Cancel block"
              aria-label="Cancel block"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          )}
        </div>
        {!collapsed && (
          <>
            <div className="flex min-h-7 items-center gap-1 border-b border-zinc-900 px-2 py-1 text-[10px] text-zinc-600">
              <span className="min-w-0 flex-1 truncate font-mono" title={block.rootDirectory}>
                {block.rootDirectory}
              </span>
              <TerminalBlockAction
                title="Copy card"
                ariaLabel="Copy full card"
                onClick={() => onCopy(blockTranscript(block))}
              >
                <Copy className="h-3 w-3" />
              </TerminalBlockAction>
              <TerminalBlockAction
                title="Copy command"
                ariaLabel="Copy command"
                onClick={() => onCopy(block.command)}
              >
                <Terminal className="h-3 w-3" />
              </TerminalBlockAction>
              <TerminalBlockAction
                title="Copy output"
                ariaLabel="Copy output"
                onClick={() => onCopy(block.output)}
              >
                <Clipboard className="h-3 w-3" />
              </TerminalBlockAction>
              <TerminalBlockAction
                title="Rerun card"
                ariaLabel="Rerun card"
                onClick={() => onRerun(block)}
              >
                <RotateCcw className="h-3 w-3" />
              </TerminalBlockAction>
              <TerminalBlockAction
                title="Interactive rerun"
                ariaLabel="Rerun card in interactive terminal mode"
                onClick={() => onInteractiveRerun(block)}
              >
                <Terminal className="h-3 w-3" />
              </TerminalBlockAction>
              <TerminalBlockAction
                title="Delete card"
                ariaLabel="Delete card"
                destructive
                onClick={() => onDeleteCard(block)}
              >
                <Trash2 className="h-3 w-3" />
              </TerminalBlockAction>
            </div>
            {block.executionMode === "interactive" && running ? (
              <InteractiveTerminalBlockOutput
                key={block.id}
                block={block}
                onInput={onInteractiveInput}
                onResize={onInteractiveResize}
              />
            ) : (
              <pre
                onContextMenu={handleOutputContextMenu}
                className="max-h-36 overflow-auto whitespace-pre-wrap break-words py-2 pl-2 pr-4 font-mono text-[11px] leading-4 text-zinc-300 [scrollbar-gutter:stable]"
              >
                {block.output || (running ? "Running..." : block.error || "No output")}
              </pre>
            )}
            {block.truncated && (
              <div className="border-t border-zinc-900 px-2 py-1 text-[10px] text-amber-300">
                Output truncated.
              </div>
            )}
          </>
        )}
      </section>
    );
  },
);

interface InteractiveTerminalBlockOutputProps {
  block: TerminalBlockSnapshot;
  onInput: (blockId: string, input: string) => void;
  onResize: (blockId: string, cols: number, rows: number) => void;
}

function InteractiveTerminalBlockOutput({
  block,
  onInput,
  onResize,
}: InteractiveTerminalBlockOutputProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastOutputLengthRef = useRef(0);
  const handlersRef = useRef({ onInput, onResize });
  const initialOutputRef = useRef(block.output);

  useEffect(() => {
    handlersRef.current = { onInput, onResize };
  }, [onInput, onResize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 11,
      fontFamily: '"IBM Plex Mono", Menlo, Monaco, "Courier New", monospace',
      scrollback: 1000,
      convertEol: true,
      theme: {
        background: "#020202",
        foreground: "#d4d4d8",
        cursor: "#d4d4d8",
        selectionBackground: "#3f3f46",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    lastOutputLengthRef.current = initialOutputRef.current.length;
    if (initialOutputRef.current) {
      terminal.write(initialOutputRef.current);
    }

    const dataDisposable = terminal.onData((input) => {
      handlersRef.current.onInput(block.id, input);
    });

    let resizeFrame: number | null = null;
    const fitAndReport = () => {
      resizeFrame = null;
      try {
        fitAddon.fit();
        handlersRef.current.onResize(block.id, terminal.cols, terminal.rows);
      } catch {
        // xterm can briefly report zero dimensions while the popover is animating.
      }
    };
    const scheduleFit = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(fitAndReport);
    };

    scheduleFit();
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(container);

    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      observer.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastOutputLengthRef.current = 0;
    };
  }, [block.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (block.output.length < lastOutputLengthRef.current) {
      terminal.reset();
      terminal.write(block.output);
    } else if (block.output.length > lastOutputLengthRef.current) {
      terminal.write(block.output.slice(lastOutputLengthRef.current));
    }
    lastOutputLengthRef.current = block.output.length;
  }, [block.output]);

  return (
    <div className="border-t border-zinc-950 bg-black">
      <div
        ref={containerRef}
        className="h-40 overflow-hidden px-1 py-1 [&_.xterm-screen]:rounded-sm [&_.xterm]:h-full"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

interface TerminalBlockSelectionToolbarProps {
  selectedBlocks: TerminalBlockSnapshot[];
  onClear: () => void;
  onCopyBlocks: () => void;
  onCopyCommands: () => void;
  onCopyOutputs: () => void;
  onDelete: () => void;
  onRerun: () => void;
}

function TerminalBlockSelectionToolbar({
  selectedBlocks,
  onClear,
  onCopyBlocks,
  onCopyCommands,
  onCopyOutputs,
  onDelete,
  onRerun,
}: TerminalBlockSelectionToolbarProps) {
  const selectedCount = selectedBlocks.length;
  const runningCount = selectedBlocks.filter((block) => block.status === "running").length;

  return (
    <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950/80 px-2 py-1">
      <span className="mr-auto rounded border border-sky-900/60 bg-sky-950/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-300">
        {selectedCount} selected
      </span>
      <TerminalBlockAction
        title="Copy selected cards"
        ariaLabel="Copy selected cards"
        onClick={onCopyBlocks}
      >
        <Copy className="h-3 w-3" />
      </TerminalBlockAction>
      <TerminalBlockAction
        title="Copy selected commands"
        ariaLabel="Copy selected commands"
        onClick={onCopyCommands}
      >
        <Terminal className="h-3 w-3" />
      </TerminalBlockAction>
      <TerminalBlockAction
        title="Copy selected outputs"
        ariaLabel="Copy selected outputs"
        onClick={onCopyOutputs}
      >
        <Clipboard className="h-3 w-3" />
      </TerminalBlockAction>
      <TerminalBlockAction
        title="Rerun selected cards"
        ariaLabel="Rerun selected cards"
        onClick={onRerun}
      >
        <RotateCcw className="h-3 w-3" />
      </TerminalBlockAction>
      <TerminalBlockAction
        title={runningCount > 0 ? "Cancel and delete selected cards" : "Delete selected cards"}
        ariaLabel={runningCount > 0 ? "Cancel and delete selected cards" : "Delete selected cards"}
        destructive
        onClick={onDelete}
      >
        <Trash2 className="h-3 w-3" />
      </TerminalBlockAction>
      <TerminalBlockAction title="Clear selection" ariaLabel="Clear selection" onClick={onClear}>
        <X className="h-3 w-3" />
      </TerminalBlockAction>
    </div>
  );
}

interface TerminalBlockPageButtonProps {
  title: string;
  ariaLabel: string;
  disabled: boolean;
  children: ReactNode;
  onClick: () => void;
}

function TerminalBlockPageButton({
  title,
  ariaLabel,
  disabled,
  children,
  onClick,
}: TerminalBlockPageButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex h-5 w-5 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

interface TerminalBlockActionProps {
  title: string;
  ariaLabel: string;
  destructive?: boolean;
  children: ReactNode;
  onClick: () => void;
}

function TerminalBlockAction({
  title,
  ariaLabel,
  destructive = false,
  children,
  onClick,
}: TerminalBlockActionProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200",
        destructive && "hover:bg-red-950/50 hover:text-red-300",
      )}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}
