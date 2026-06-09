import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const TERMINAL_BLOCK_EVENT = "terminal-block-event";
export const LAUNCHER_TERMINAL_BLOCK_SCOPE = "launcher";

export type TerminalBlockStatus = "running" | "success" | "failed" | "cancelled";
export type TerminalBlockExecutionMode = "captured" | "interactive";

export interface TerminalBlockSnapshot {
  id: string;
  scopeId: string;
  command: string;
  rootDirectory: string;
  tabId: string | null;
  runGroupId: string;
  runIndex: number;
  status: TerminalBlockStatus;
  executionMode: TerminalBlockExecutionMode;
  output: string;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  truncated: boolean;
  error: string | null;
}

export interface TerminalBlockEvent {
  kind: "started" | "output" | "interactiveOutput" | "finished" | "deleted";
  scopeId: string;
  blockId: string;
  output?: string;
  block?: TerminalBlockSnapshot;
}

export interface StartTerminalBlockInput {
  scopeId: string;
  blockId: string;
  command: string;
  rootDirectory: string | null;
  tabId: string | null;
  runGroupId?: string | null;
  runIndex?: number | null;
}

export interface StartInteractiveTerminalBlockInput extends StartTerminalBlockInput {
  cols?: number | null;
  rows?: number | null;
  seedOutput?: string | null;
}

export function listTerminalBlocks(scopeId: string): Promise<TerminalBlockSnapshot[]> {
  return invoke<TerminalBlockSnapshot[]>("list_terminal_blocks", { scopeId });
}

export function startTerminalBlock(input: StartTerminalBlockInput): Promise<TerminalBlockSnapshot> {
  return invoke<TerminalBlockSnapshot>("start_terminal_block", { ...input });
}

export function startInteractiveTerminalBlock(
  input: StartInteractiveTerminalBlockInput,
): Promise<TerminalBlockSnapshot> {
  return invoke<TerminalBlockSnapshot>("start_interactive_terminal_block", { ...input });
}

export function writeInteractiveTerminalBlock(blockId: string, input: string): Promise<void> {
  return invoke<void>("write_interactive_terminal_block", { blockId, input });
}

export function resizeInteractiveTerminalBlock(
  blockId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("resize_interactive_terminal_block", { blockId, cols, rows });
}

export function cancelTerminalBlock(blockId: string): Promise<void> {
  return invoke<void>("cancel_terminal_block", { blockId });
}

export function deleteTerminalBlock(blockId: string): Promise<void> {
  return invoke<void>("delete_terminal_block", { blockId });
}

export function listenTerminalBlockEvents(
  handler: (event: TerminalBlockEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalBlockEvent>(TERMINAL_BLOCK_EVENT, (event) => handler(event.payload));
}
