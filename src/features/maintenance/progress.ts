/**
 * Reading `occurrence_progress_item` rows back into "where was I?".
 *
 * Pure, because "resume at the first unfinished step" is the behaviour a phone in a cold utility
 * room depends on, and it should be provable without a browser.
 */
export interface ProgressLike {
  itemKind: "step" | "checklist";
  stepId: string | null;
  checklistItemId: string | null;
  state: "todo" | "in_progress" | "done" | "skipped";
}

export interface StepLike {
  id: string;
  isOptional: boolean;
  checklist: { id: string }[];
}

export interface ProgressIndex {
  stepState: Map<string, ProgressLike["state"]>;
  checklistState: Map<string, ProgressLike["state"]>;
}

export function indexProgress(rows: readonly ProgressLike[]): ProgressIndex {
  const stepState = new Map<string, ProgressLike["state"]>();
  const checklistState = new Map<string, ProgressLike["state"]>();
  for (const row of rows) {
    if (row.itemKind === "step" && row.stepId !== null) stepState.set(row.stepId, row.state);
    if (row.itemKind === "checklist" && row.checklistItemId !== null) {
      checklistState.set(row.checklistItemId, row.state);
    }
  }
  return { stepState, checklistState };
}

/** A step counts as settled once it is `done` or deliberately `skipped`. */
export function isSettled(state: ProgressLike["state"] | undefined): boolean {
  return state === "done" || state === "skipped";
}

/**
 * The step to open first: the earliest one that is neither done nor skipped. `null` when every
 * step is settled — the UI then shows the whole procedure collapsed with a "ready to complete"
 * note rather than opening a random step.
 */
export function firstUnfinishedStepId(
  steps: readonly StepLike[],
  rows: readonly ProgressLike[],
): string | null {
  const { stepState } = indexProgress(rows);
  for (const step of steps) {
    if (!isSettled(stepState.get(step.id))) return step.id;
  }
  return null;
}

export interface ProgressSummary {
  /** Steps that are done or skipped. */
  settled: number;
  total: number;
  /** Required checklist items still untouched, across all steps. */
  openChecklistItems: number;
  /** Every step settled. Not the same as "completed" — the completion is a separate act. */
  allSettled: boolean;
}

export function summariseProgress(
  steps: readonly StepLike[],
  looseChecklist: readonly { id: string }[],
  rows: readonly ProgressLike[],
): ProgressSummary {
  const { stepState, checklistState } = indexProgress(rows);
  const settled = steps.filter((step) => isSettled(stepState.get(step.id))).length;
  const allChecklist = [...steps.flatMap((step) => step.checklist), ...looseChecklist];
  const openChecklistItems = allChecklist.filter(
    (item) => !isSettled(checklistState.get(item.id)),
  ).length;
  return {
    settled,
    total: steps.length,
    openChecklistItems,
    allSettled: steps.length > 0 && settled === steps.length,
  };
}
