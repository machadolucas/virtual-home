"use client";
/** Explicit editor scopes only: searches and filters never become unsaved work. */
const dirty = new Map<HTMLElement, number>();
const listeners = new Set<() => void>();
let interactionScope: HTMLElement | null = null;
/** Safari does not focus buttons on pointer activation; attribute saves to the real event owner. */
export function captureEditorInteraction(target: EventTarget | null) { interactionScope = editorScope(target); }
export function editorScope(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-unsaved]") : null;
}
export function markEditorDirty(scope: HTMLElement) {
  dirty.set(scope, (dirty.get(scope) ?? 0) + 1); listeners.forEach(fn=>fn());
}
export function hasUnsavedEdits(transientOnly = false) {
  for (const scope of dirty.keys()) if (!scope.isConnected) dirty.delete(scope);
  return [...dirty.keys()].some(scope => !transientOnly || !scope.closest("[data-record-scope]"));
}
export function subscribeUnsaved(fn: () => void) { listeners.add(fn); return () => {listeners.delete(fn);}; }
export function clearUnsavedEdits() {dirty.clear(); listeners.forEach(fn=>fn());}
/** Capture before awaiting so another edit during a save remains protected. */
export function savingEditor() {
  const scope = typeof document === "undefined" ? null : (interactionScope?.isConnected ? interactionScope : editorScope(document.activeElement));
  const revision = scope ? dirty.get(scope) : undefined;
  return () => {
    if (scope && dirty.get(scope) === revision) {dirty.delete(scope); listeners.forEach(fn=>fn());}
  };
}
export function confirmDiscardEdits(owner?: HTMLElement | null) {
  const scopes = [...dirty.keys()].filter(scope => owner ? owner.contains(scope) || scope === owner : !scope.closest("[data-record-scope]"));
  if (!scopes.length) return true;
  if (!window.confirm("You have unsaved changes. Discard them and leave?")) return false;
  scopes.forEach(scope => dirty.delete(scope)); listeners.forEach(fn=>fn()); return true;
}
export function markActiveEditorDirty() {
  const scope = editorScope(document.activeElement);
  if (scope) markEditorDirty(scope);
}

export function recordHasUnsavedEdits(href: string) { return [...dirty.keys()].some(scope => scope.isConnected && scope.closest<HTMLElement>("[data-record-scope]")?.dataset.recordScope === href); }
