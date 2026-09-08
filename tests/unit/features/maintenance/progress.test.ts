/**
 * "Where was I?" — resuming a guided procedure.
 *
 * A step counts as settled when it is done *or* deliberately skipped, which is what stops the
 * runner reopening a step somebody consciously chose to leave out.
 */
import { describe, expect, it } from "vitest";
import {
  firstUnfinishedStepId,
  indexProgress,
  isSettled,
  summariseProgress,
  type ProgressLike,
} from "@/features/maintenance/progress";

const steps = [
  { id: "s1", isOptional: false, checklist: [{ id: "c1" }, { id: "c2" }] },
  { id: "s2", isOptional: true, checklist: [] },
  { id: "s3", isOptional: false, checklist: [{ id: "c3" }] },
];

function step(id: string, state: ProgressLike["state"]): ProgressLike {
  return { itemKind: "step", stepId: id, checklistItemId: null, state, valueText: null, valueNumber: null };
}

function check(
  id: string,
  state: ProgressLike["state"],
  value: { valueText?: string | null; valueNumber?: number | null } = {},
): ProgressLike {
  return {
    itemKind: "checklist",
    stepId: null,
    checklistItemId: id,
    state,
    valueText: value.valueText ?? null,
    valueNumber: value.valueNumber ?? null,
  };
}

describe("isSettled", () => {
  it("counts done and skipped, and nothing else", () => {
    expect(isSettled("done")).toBe(true);
    expect(isSettled("skipped")).toBe(true);
    expect(isSettled("in_progress")).toBe(false);
    expect(isSettled("todo")).toBe(false);
    expect(isSettled(undefined)).toBe(false);
  });
});

describe("indexProgress", () => {
  it("keys steps and checklist items separately", () => {
    const index = indexProgress([step("s1", "done"), check("c1", "done")]);
    expect(index.stepState.get("s1")).toBe("done");
    expect(index.checklistState.get("c1")).toBe("done");
    expect(index.stepState.get("c1")).toBeUndefined();
  });

  it("carries the value a checklist item recorded, so the runner can show it back", () => {
    const index = indexProgress([
      check("c1", "done", { valueNumber: 21.4 }),
      check("c2", "done", { valueText: "batch 220" }),
      check("c3", "todo"),
    ]);
    expect(index.checklistValue.get("c1")).toEqual({ valueText: null, valueNumber: 21.4 });
    expect(index.checklistValue.get("c2")).toEqual({ valueText: "batch 220", valueNumber: null });
    expect(index.checklistValue.get("c3")).toEqual({ valueText: null, valueNumber: null });
    // A step has no value of its own, and asking for one is a lookup miss rather than a null row.
    expect(index.checklistValue.get("s1")).toBeUndefined();
  });
});

describe("firstUnfinishedStepId", () => {
  it("opens the first step when nothing has been touched", () => {
    expect(firstUnfinishedStepId(steps, [])).toBe("s1");
  });

  it("resumes after the steps that are done", () => {
    expect(firstUnfinishedStepId(steps, [step("s1", "done")])).toBe("s2");
  });

  it("does not reopen a step that was deliberately skipped", () => {
    expect(firstUnfinishedStepId(steps, [step("s1", "done"), step("s2", "skipped")])).toBe("s3");
  });

  it("returns null once everything is settled, rather than picking a step at random", () => {
    expect(
      firstUnfinishedStepId(steps, [
        step("s1", "done"),
        step("s2", "skipped"),
        step("s3", "done"),
      ]),
    ).toBeNull();
  });

  it("treats in-progress as unfinished", () => {
    expect(firstUnfinishedStepId(steps, [step("s1", "in_progress")])).toBe("s1");
  });
});

describe("summariseProgress", () => {
  it("counts settled steps and untouched checks across steps and the final list", () => {
    const summary = summariseProgress(steps, [{ id: "final1" }], [
      step("s1", "done"),
      check("c1", "done"),
    ]);
    expect(summary).toEqual({
      settled: 1,
      total: 3,
      // c2, c3 and final1 are still open.
      openChecklistItems: 3,
      allSettled: false,
    });
  });

  it("reports all steps settled without claiming the task is complete", () => {
    const summary = summariseProgress(steps, [], [
      step("s1", "done"),
      step("s2", "done"),
      step("s3", "skipped"),
    ]);
    expect(summary.allSettled).toBe(true);
    // Checks are still open: "every step ticked" is not "recorded as done".
    expect(summary.openChecklistItems).toBe(3);
  });

  it("never claims allSettled for a procedure with no steps", () => {
    expect(summariseProgress([], [], []).allSettled).toBe(false);
  });
});
