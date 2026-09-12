"use client";
/** Explicit editor scopes only: searches and filters never become unsaved work. */
const dirty = new Map<HTMLElement, number>();
const listeners = new Set<() => void>();
export function editorScope(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-unsaved]") : null;
}
export function markEditorDirty(scope: HTMLElement) {
  dirty.set(scope, (dirty.get(scope) ?? 0) + 1); listeners.forEach(fn=>fn());
}
export function hasUnsavedEdits() {
  for (const scope of dirty.keys()) if (!scope.isConnected) dirty.delete(scope);
  return dirty.size > 0;
}
export function subscribeUnsaved(fn: () => void) { listeners.add(fn); return () => {listeners.delete(fn);}; }
export function clearUnsavedEdits() {dirty.clear(); listeners.forEach(fn=>fn());}
/** Capture before awaiting so another edit during a save remains protected. */
export function savingEditor() {
  const scope = typeof document === "undefined" ? null : editorScope(document.activeElement);
  const revision = scope ? dirty.get(scope) : undefined;
  return () => {
    if (scope && dirty.get(scope) === revision) {dirty.delete(scope); listeners.forEach(fn=>fn());}
  };
}
export function confirmDiscardEdits() {
  if (!hasUnsavedEdits()) return true;
  if (!window.confirm("You have unsaved changes. Discard them and leave?")) return false;
  clearUnsavedEdits(); return true;
}
export function markActiveEditorDirty() {
  const scope = editorScope(document.activeElement);
  if (scope) markEditorDirty(scope);
}
