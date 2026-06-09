export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

export function isPanelFullscreenHotkey(event: KeyboardEvent): boolean {
  const usesModifier = navigator.platform.toLowerCase().includes("mac")
    ? event.metaKey
    : event.ctrlKey;

  return usesModifier && event.shiftKey && event.key.toLowerCase() === "f";
}
