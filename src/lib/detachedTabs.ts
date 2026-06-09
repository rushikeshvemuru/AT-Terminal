import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { DetachedWindowBounds, TabMetadata } from "@/store/useSessionStore";

export const DETACHED_TAB_READY_EVENT = "detached-tab-ready";
export const DETACHED_TAB_SNAPSHOT_EVENT = "detached-tab-snapshot";
export const DETACHED_TAB_UPDATED_EVENT = "detached-tab-updated";
export const DETACHED_TAB_REATTACH_EVENT = "detached-tab-reattach";
export const DETACHED_TAB_CLOSE_EVENT = "detached-tab-close";
export const DETACHED_TAB_BOUNDS_EVENT = "detached-tab-bounds";

export interface SessionClaimResult {
  status: "claimed" | "focusedExisting";
  ownerLabel: string;
}

export interface DetachedTabWindowPayload {
  sessionId: string;
  tabId: string;
  ownerLabel: string;
  windowLabel: string;
}

export interface DetachedTabSnapshotPayload extends DetachedTabWindowPayload {
  tab: TabMetadata;
}

export interface DetachedTabActionPayload {
  sessionId: string;
  tabId: string;
  windowLabel: string;
  confirmed?: boolean;
}

export interface DetachedTabBoundsPayload extends DetachedTabActionPayload {
  bounds: DetachedWindowBounds;
}

export function claimSessionWindow(sessionId: string) {
  return invoke<SessionClaimResult>("claim_session_window", { sessionId });
}

export function releaseSessionWindow(sessionId: string) {
  return invoke<void>("release_session_window", { sessionId });
}

export function focusSessionOwner(sessionId: string) {
  return invoke<void>("focus_session_owner", { sessionId });
}

export function openDetachedTabWindow(
  sessionId: string,
  tabId: string,
  tabName: string,
  bounds?: DetachedWindowBounds | null,
) {
  return invoke<DetachedTabWindowPayload>("open_detached_tab_window", {
    sessionId,
    tabId,
    tabName,
    bounds: bounds ?? null,
  });
}

export function waitForOwnerDetachRender() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function focusDetachedTabWindow(sessionId: string, tabId: string) {
  return invoke<void>("focus_detached_tab_window", { sessionId, tabId });
}

export function closeDetachedTabWindow(sessionId: string, tabId: string) {
  return invoke<void>("close_detached_tab_window", { sessionId, tabId });
}

export function closeDetachedTabWindowsForSession(sessionId: string) {
  return invoke<void>("close_detached_tab_windows_for_session", { sessionId });
}

export function getDetachedTabWindowPayload() {
  return invoke<DetachedTabWindowPayload>("get_detached_tab_window_payload");
}

export function updateDetachedTabBounds(
  sessionId: string,
  tabId: string,
  bounds: DetachedWindowBounds,
) {
  return invoke<void>("update_detached_tab_bounds", { sessionId, tabId, bounds });
}

export function emitDetachedTabReady(payload: DetachedTabActionPayload, ownerLabel: string) {
  return emitTo(ownerLabel, DETACHED_TAB_READY_EVENT, payload);
}

export function emitDetachedTabSnapshot(
  payload: DetachedTabSnapshotPayload,
  detachedWindowLabel: string,
) {
  return emitTo(detachedWindowLabel, DETACHED_TAB_SNAPSHOT_EVENT, payload);
}

export function emitDetachedTabUpdated(payload: DetachedTabSnapshotPayload, ownerLabel: string) {
  return emitTo(ownerLabel, DETACHED_TAB_UPDATED_EVENT, payload);
}

export function emitDetachedTabReattach(payload: DetachedTabActionPayload, ownerLabel: string) {
  return emitTo(ownerLabel, DETACHED_TAB_REATTACH_EVENT, payload);
}

export function emitDetachedTabClose(payload: DetachedTabActionPayload, ownerLabel: string) {
  return emitTo(ownerLabel, DETACHED_TAB_CLOSE_EVENT, payload);
}

export function emitDetachedTabBounds(payload: DetachedTabBoundsPayload, ownerLabel: string) {
  return emitTo(ownerLabel, DETACHED_TAB_BOUNDS_EVENT, payload);
}

export function listenDetachedTabReady(
  handler: (payload: DetachedTabActionPayload) => void,
): Promise<UnlistenFn> {
  return listen<DetachedTabActionPayload>(DETACHED_TAB_READY_EVENT, (event) =>
    handler(event.payload),
  );
}

export function listenDetachedTabSnapshot(
  handler: (payload: DetachedTabSnapshotPayload) => void,
): Promise<UnlistenFn> {
  return listen<DetachedTabSnapshotPayload>(DETACHED_TAB_SNAPSHOT_EVENT, (event) =>
    handler(event.payload),
  );
}

export function listenDetachedTabUpdated(
  handler: (payload: DetachedTabSnapshotPayload) => void,
): Promise<UnlistenFn> {
  return listen<DetachedTabSnapshotPayload>(DETACHED_TAB_UPDATED_EVENT, (event) =>
    handler(event.payload),
  );
}

export function listenDetachedTabReattach(
  handler: (payload: DetachedTabActionPayload) => void,
): Promise<UnlistenFn> {
  return listen<DetachedTabActionPayload>(DETACHED_TAB_REATTACH_EVENT, (event) =>
    handler(event.payload),
  );
}

export function listenDetachedTabClose(
  handler: (payload: DetachedTabActionPayload) => void,
): Promise<UnlistenFn> {
  return listen<DetachedTabActionPayload>(DETACHED_TAB_CLOSE_EVENT, (event) =>
    handler(event.payload),
  );
}

export function listenDetachedTabBounds(
  handler: (payload: DetachedTabBoundsPayload) => void,
): Promise<UnlistenFn> {
  return listen<DetachedTabBoundsPayload>(DETACHED_TAB_BOUNDS_EVENT, (event) =>
    handler(event.payload),
  );
}
