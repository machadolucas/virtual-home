/**
 * The words and small pure functions the reconciliation screen is built from.
 *
 * These matter more than their size suggests: the panel is the only place a person meets D-016, so
 * the vocabulary ("Remap", "Keep", "Archive") and the sentence that says what each answer will do
 * are the feature's user interface. The coverage assertions below are written against the schema's
 * own enums rather than a hand-copied list, so a new entity kind or issue makes a test fail
 * instead of quietly rendering as `snake_case`.
 */
import { describe, expect, it } from "vitest";

import {
  RECONCILIATION_DECISIONS as SCHEMA_DECISIONS,
  RECONCILIATION_ENTITY_KINDS,
  RECONCILIATION_ISSUES,
} from "@/db/schema";
import {
  DECISION_BLURB,
  DECISION_LABEL,
  ENTITY_KIND_LABEL,
  ISSUE_LABEL,
  RECONCILIATION_DECISIONS,
  RECONCILIATION_MESSAGES,
  applyConsequences,
  candidateHint,
  candidateLabel,
  countDecisions,
  decisionAvailable,
  decisionSummary,
  defaultRemapTarget,
  entityKindLabel,
  formatDistance,
  formatScore,
  issueLabel,
  summaryEntries,
  summaryLine,
  type ItemView,
} from "@/features/settings/model/reconciliation";

function item(overrides: Partial<ItemView> = {}): ItemView {
  return {
    id: "i1",
    entityKind: "asset_placement",
    entityId: "p1",
    oldNodeId: "r-l-closet",
    issue: "node_missing",
    proposedAction: "remap",
    proposedNewNodeId: "r-l-closet-renamed",
    decision: null,
    decidedNewNodeId: null,
    decidedByName: null,
    note: null,
    candidates: [],
    ...overrides,
  };
}

describe("vocabulary", () => {
  it("names every entity kind, issue and decision the schema allows", () => {
    for (const kind of RECONCILIATION_ENTITY_KINDS) {
      expect(ENTITY_KIND_LABEL[kind], kind).toBeDefined();
    }
    for (const issue of RECONCILIATION_ISSUES) {
      expect(ISSUE_LABEL[issue], issue).toBeDefined();
    }
    expect([...RECONCILIATION_DECISIONS]).toEqual([...SCHEMA_DECISIONS]);
    for (const decision of RECONCILIATION_DECISIONS) {
      expect(DECISION_LABEL[decision]).toBeTruthy();
      expect(DECISION_BLURB[decision]).toBeTruthy();
    }
  });

  it("explains every code the reconciliation service can refuse with", () => {
    // The `code` strings thrown by `src/server/house-model/revision.ts`; a code with no sentence
    // would reach the screen raw.
    for (const code of [
      "undecided_items",
      "reconciliation_not_open",
      "unknown_node",
      "remap_needs_node",
      "remap_target_taken",
      "location_not_archivable",
    ]) {
      expect(RECONCILIATION_MESSAGES[code], code).toBeTruthy();
    }
  });

  it("falls back to the raw name rather than hiding an unknown kind or issue", () => {
    expect(entityKindLabel("asset_placement")).toBe("Equipment placement");
    expect(entityKindLabel("something_new")).toBe("something new");
    expect(issueLabel("node_missing")).toBe("identifier is gone");
    expect(issueLabel("brand_new_issue")).toBe("brand new issue");
  });
});

describe("candidates", () => {
  it("shows a score as a percentage, and an unknown score as an em dash rather than 0 %", () => {
    expect(formatScore(0.834)).toBe("83 %");
    expect(formatScore(0)).toBe("0 %");
    expect(formatScore(undefined)).toBe("—");
    expect(formatDistance(1.5)).toBe("1.50 m away");
    expect(formatDistance(undefined)).toBeNull();
  });

  it("labels a candidate by its id, adding the name only when it says something else", () => {
    expect(candidateLabel({ nodeId: "r-l-a", name: "Room A" })).toBe("r-l-a — Room A");
    expect(candidateLabel({ nodeId: "r-l-a", name: "r-l-a" })).toBe("r-l-a");
    expect(candidateLabel({ nodeId: "r-l-a" })).toBe("r-l-a");
    expect(candidateHint({ nodeId: "r-l-a", score: 0.8, kind: "room", centroidDistanceM: 0.25 })).toBe(
      "80 % · room · 0.25 m away",
    );
    expect(candidateHint({ nodeId: "r-l-a" })).toBe("—");
  });

  it("starts a remap from the recorded answer, then the proposal, then the best candidate", () => {
    expect(defaultRemapTarget(item({ decidedNewNodeId: "a", proposedNewNodeId: "b" }))).toBe("a");
    expect(defaultRemapTarget(item({ proposedNewNodeId: "b" }))).toBe("b");
    expect(
      defaultRemapTarget(item({ proposedNewNodeId: null, candidates: [{ nodeId: "c" }, { nodeId: "d" }] })),
    ).toBe("c");
    expect(defaultRemapTarget(item({ proposedNewNodeId: null }))).toBe("");
  });
});

describe("decisions", () => {
  it("counts what is answered and what is still open", () => {
    expect(
      countDecisions([
        item({ decision: "remap" }),
        item({ decision: "remap" }),
        item({ decision: "keep" }),
        item(),
      ]),
    ).toEqual({ remap: 2, keep: 1, archive: 0, undecided: 1 });
  });

  it("never offers archive for a location", () => {
    expect(decisionAvailable("archive", "location")).toBe(false);
    expect(decisionAvailable("keep", "location")).toBe(true);
    expect(decisionAvailable("remap", "location")).toBe(true);
    expect(decisionAvailable("archive", "asset_placement")).toBe(true);
  });

  it("reads a recorded decision back, with the target for a remap", () => {
    expect(decisionSummary(item())).toBeNull();
    expect(decisionSummary(item({ decision: "keep" }))).toBe("Keep");
    expect(decisionSummary(item({ decision: "remap", decidedNewNodeId: "r-x" }))).toBe("Remap → r-x");
  });
});

describe("the confirmation", () => {
  it("states the counts that are not zero, and always what happens to everything else", () => {
    const lines = applyConsequences({ remap: 2, keep: 0, archive: 1, undecided: 0 });
    expect(lines.some((line) => line.includes("2 record(s) will be re-pointed"))).toBe(true);
    expect(lines.some((line) => line.includes("will keep their old identifier"))).toBe(false);
    expect(lines.some((line) => line.includes("1 record(s) will be archived"))).toBe(true);
    // The two sentences that are true of every apply: nothing else changes, and the pointer moves.
    expect(lines.at(-2)).toContain("carried over unchanged");
    expect(lines.at(-1)).toContain("becomes current");
  });

  it("says something even when every decision was to keep", () => {
    const lines = applyConsequences({ remap: 0, keep: 3, archive: 0, undecided: 0 });
    expect(lines[0]).toContain("3 record(s) will keep their old identifier");
    expect(lines).toHaveLength(3);
  });
});

describe("the recorded outcome", () => {
  it("labels the counts summary_json carries, in a readable order", () => {
    expect(
      summaryEntries({ archive: 1, total: 4, remap: 2, keep: 1, flaggedMoves: 0, abandonedAtMs: 1_700_000_000_000 }),
    ).toEqual([
      { key: "total", label: "items", value: 4 },
      { key: "remap", label: "remapped", value: 2 },
      { key: "keep", label: "kept", value: 1 },
      { key: "archive", label: "archived", value: 1 },
      { key: "flaggedMoves", label: "positions flagged for review", value: 0 },
    ]);
  });

  it("shows an unrecognised count under its own name, and skips anything that is not one", () => {
    expect(summaryEntries({ somethingNew: 3, note: "text", ratio: null })).toEqual([
      { key: "somethingNew", label: "somethingNew", value: 3 },
    ]);
    expect(summaryEntries(null)).toEqual([]);
    expect(summaryLine(null)).toBe("");
    expect(summaryLine({ remap: 1, keep: 2 })).toBe("1 remapped · 2 kept");
  });
});
