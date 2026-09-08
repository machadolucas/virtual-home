/**
 * Words and small pure functions for the reconciliation screen.
 *
 * The view types are declared here rather than imported from the query module so the client
 * component never has a reason to reach into `server-only` code, and so the vocabulary a person
 * reads on screen ("Remap", "Keep", "Archive") lives in one place next to the sentence that
 * explains what each one will actually do.
 */

export const RECONCILIATION_DECISIONS = ["remap", "keep", "archive"] as const;
export type Decision = (typeof RECONCILIATION_DECISIONS)[number];

export interface CandidateView {
  nodeId: string;
  name?: string;
  kind?: string;
  score?: number;
  centroidDistanceM?: number;
}

export interface ItemView {
  id: string;
  entityKind: string;
  entityId: string;
  oldNodeId: string;
  issue: string;
  proposedAction: string;
  proposedNewNodeId: string | null;
  decision: Decision | null;
  decidedNewNodeId: string | null;
  decidedByName: string | null;
  note: string | null;
  candidates: CandidateView[];
}

export interface PlanView {
  id: string;
  status: "open" | "applied" | "abandoned";
  fromLabel: string;
  toLabel: string;
  createdAtMs: number;
  appliedAtMs: number | null;
  items: ItemView[];
  total: number;
  decided: number;
  undecided: number;
  applicable: boolean;
  /** `model_reconciliation.summary_json`, parsed. Counts by outcome; `null` before an outcome. */
  summary: Record<string, unknown> | null;
}

/** Plain-English name for each reconcilable table. */
export const ENTITY_KIND_LABEL: Record<string, string> = {
  location: "Location",
  asset_placement: "Equipment placement",
  infra_route: "Route",
  infra_route_point: "Route point",
  infra_endpoint: "Route endpoint",
  annotation: "Annotation",
  storage_place: "Storage place",
  surface_color_override: "Surface colour",
};

/** What the import noticed. `node_missing` is by far the common one. */
export const ISSUE_LABEL: Record<string, string> = {
  node_missing: "identifier is gone",
  kind_changed: "identifier changed kind",
  moved_beyond_tolerance: "moved further than the tolerance",
  parent_changed: "moved to a different parent",
  duplicate_node: "identifier appears twice",
};

export const DECISION_LABEL: Record<Decision, string> = {
  remap: "Remap",
  keep: "Keep",
  archive: "Archive",
};

/** The consequence of each answer, in the words the confirm dialog also uses. */
export const DECISION_BLURB: Record<Decision, string> = {
  remap:
    "Point the record at an identifier the new package does have. Its position is re-projected by the difference between the two nodes' centroids, and anything that moves more than 2 m is flagged for a look.",
  keep:
    "Leave the record where it is. It stays fully usable and stays flagged as unplaced, and the decision is remembered so the next import does not ask again.",
  archive:
    "Retire the record. A route is marked removed, a storage place is unpinned from the model, and anything else is removed with its complete contents written to the history log so it can be restored. Locations are never archived.",
};

/** Decision codes the reconciliation actions can return, mapped to sentences. */
export const RECONCILIATION_MESSAGES: Record<string, string> = {
  undecided_items: "Every row needs an answer before this can be applied.",
  reconciliation_not_open: "This reconciliation has already been applied or abandoned. Reload the page.",
  unknown_node: "The new package has no identifier by that name. Check the spelling, or pick a candidate.",
  remap_needs_node: "Choose a candidate, or type the identifier to point at.",
  remap_target_taken: "Another record already claims that identifier. Deal with that one first.",
  location_not_archivable:
    "A location anchors equipment, storage and history, so it is never archived — remap it or keep it.",
};

export function entityKindLabel(kind: string): string {
  return ENTITY_KIND_LABEL[kind] ?? kind.replace(/_/g, " ");
}

export function issueLabel(issue: string): string {
  return ISSUE_LABEL[issue] ?? issue.replace(/_/g, " ");
}

/** `0.83` → `"83 %"`. Undefined scores show as an em dash, never as `0 %`. */
export function formatScore(score: number | undefined): string {
  return score === undefined ? "—" : `${Math.round(score * 100)} %`;
}

export function formatDistance(metres: number | undefined): string | null {
  return metres === undefined ? null : `${metres.toFixed(2)} m away`;
}

/** One candidate as a select option label: the id carries the meaning, the rest is context. */
export function candidateLabel(candidate: CandidateView): string {
  const parts = [candidate.nodeId];
  if (candidate.name !== undefined && candidate.name !== candidate.nodeId) parts.push(`— ${candidate.name}`);
  return parts.join(" ");
}

export function candidateHint(candidate: CandidateView): string {
  const bits = [formatScore(candidate.score)];
  if (candidate.kind !== undefined) bits.push(candidate.kind);
  const distance = formatDistance(candidate.centroidDistanceM);
  if (distance !== null) bits.push(distance);
  return bits.join(" · ");
}

export interface DecisionCounts {
  remap: number;
  keep: number;
  archive: number;
  undecided: number;
}

export function countDecisions(items: readonly ItemView[]): DecisionCounts {
  const counts: DecisionCounts = { remap: 0, keep: 0, archive: 0, undecided: 0 };
  for (const item of items) {
    if (item.decision === null) counts.undecided += 1;
    else counts[item.decision] += 1;
  }
  return counts;
}

/**
 * What applying is about to do, as one sentence per non-zero outcome. Written from the counts
 * rather than a generic "this cannot be undone", because the specific numbers are what make the
 * confirmation meaningful.
 */
export function applyConsequences(counts: DecisionCounts): string[] {
  const lines: string[] = [];
  if (counts.remap > 0) {
    lines.push(
      `${counts.remap} record(s) will be re-pointed at their new identifier and their positions re-projected.`,
    );
  }
  if (counts.keep > 0) {
    lines.push(
      `${counts.keep} record(s) will keep their old identifier and stay flagged as unplaced, and that decision will be remembered.`,
    );
  }
  if (counts.archive > 0) {
    lines.push(
      `${counts.archive} record(s) will be archived — removed rows are written to the history log in full, so they can be restored.`,
    );
  }
  lines.push(
    "Everything else the old revision owned — colours, routes, endpoints, annotations, locations — is carried over unchanged.",
  );
  lines.push("The new revision becomes current, the old one is superseded, and the house view follows.");
  return lines;
}

/* -------------------------------------------------------------------------------------------------
 * Recorded outcome
 *
 * `summary_json` is written by three different code paths (opened, applied, abandoned) and each
 * writes the keys that mean something to it, so this renders whatever keys are actually there
 * rather than assuming a fixed shape. An unknown key still shows, with its raw name: a number the
 * screen cannot explain is better than a number the screen hides.
 * ---------------------------------------------------------------------------------------------- */

/** Plain-English name for each key `summary_json` is known to carry. */
export const SUMMARY_LABEL: Record<string, string> = {
  total: "items",
  remap: "remapped",
  keep: "kept",
  archive: "archived",
  decided: "decided",
  aliasCarried: "carried by a remembered decision",
  flaggedMoves: "positions flagged for review",
  flaggedUnasked: "rows flagged without being asked",
  nodeMissing: "identifiers gone",
  referenced: "records on the old revision",
  aliasRemapped: "followed a remembered rename",
  aliasHeld: "held by a remembered keep",
};

/** The order the known keys read best in; anything else follows, alphabetically. */
const SUMMARY_ORDER = [
  "total",
  "remap",
  "keep",
  "archive",
  "decided",
  "aliasCarried",
  "flaggedMoves",
  "flaggedUnasked",
  "nodeMissing",
  "referenced",
  "aliasRemapped",
  "aliasHeld",
];

export interface SummaryEntry {
  key: string;
  label: string;
  value: number;
}

/**
 * The counts in `summary_json`, labelled. Only numbers survive: `abandonedAtMs` is an instant, not
 * a count, and belongs to the timestamp shown beside the status instead.
 */
export function summaryEntries(summary: Record<string, unknown> | null): SummaryEntry[] {
  if (summary === null) return [];
  const entries: SummaryEntry[] = [];
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (key.endsWith("Ms")) continue;
    entries.push({ key, label: SUMMARY_LABEL[key] ?? key.replace(/_/g, " "), value });
  }
  return entries.sort((a, b) => {
    const ai = SUMMARY_ORDER.indexOf(a.key);
    const bi = SUMMARY_ORDER.indexOf(b.key);
    if (ai !== bi) return (ai === -1 ? SUMMARY_ORDER.length : ai) - (bi === -1 ? SUMMARY_ORDER.length : bi);
    return a.key.localeCompare(b.key);
  });
}

/** `"1 remapped · 2 kept"`. Empty when nothing was recorded, which the caller words itself. */
export function summaryLine(summary: Record<string, unknown> | null): string {
  return summaryEntries(summary)
    .map((entry) => `${entry.value} ${entry.label}`)
    .join(" · ");
}

/** Only a `remap` needs a target, and only a `location` can never be archived (design §8.3). */
export function decisionAvailable(decision: Decision, entityKind: string): boolean {
  return !(decision === "archive" && entityKind === "location");
}

/**
 * The target a remap should start from: the answer already recorded, else the import's proposal,
 * else the best-scoring candidate. Never a blind guess — every one of those three came from
 * either a human or the scorer.
 */
export function defaultRemapTarget(item: ItemView): string {
  return item.decidedNewNodeId ?? item.proposedNewNodeId ?? item.candidates[0]?.nodeId ?? "";
}

/** How a recorded decision reads in the items table. */
export function decisionSummary(item: ItemView): string | null {
  if (item.decision === null) return null;
  if (item.decision === "remap") {
    return `Remap → ${item.decidedNewNodeId ?? "?"}`;
  }
  return DECISION_LABEL[item.decision];
}
