/**
 * Words and money for the projects screens.
 *
 * Money is stored in **cents** (CLAUDE.md rule 5) and displayed in euros. The parser is the
 * interesting half: a Finnish keyboard produces "1 234,50" and a copy-paste from a PDF produces
 * "1.234,50 €", and both have to become the integer 123450 without ever passing through a float
 * that could land on 123449.99999.
 */
import type { BadgeTone } from "@/ui";
import type { ProjectKind, ProjectLinkEntityKind, ProjectStatus } from "@/db/schema/infrastructure";

export const PROJECT_KIND_LABEL: Record<ProjectKind, string> = {
  renovation: "Renovation",
  repair: "Repair",
  installation: "Installation",
  inspection: "Inspection",
  improvement: "Improvement",
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  idea: "Idea",
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
  abandoned: "Abandoned",
};

/**
 * Colour never carries the meaning alone here — the badge shows the word too. `idea` is
 * deliberately neutral: an idea is not progress.
 */
export const PROJECT_STATUS_TONE: Record<ProjectStatus, BadgeTone> = {
  idea: "neutral",
  planned: "accent",
  in_progress: "due",
  done: "ok",
  // Not `overdue`: abandoning a project is a decision, not a failure state.
  abandoned: "unknown",
};

export const PROJECT_LINK_LABEL: Record<ProjectLinkEntityKind, string> = {
  asset: "Equipment",
  location: "Location",
  system: "System",
  occurrence: "Task",
  completion: "Completed work",
  service_document: "Service document",
  part: "Supply",
  infra_route: "Infrastructure route",
};

/**
 * The roles the project pages give meaning to. `before` and `after` are the pair that makes a
 * renovation legible years later; anything else is a file with a name.
 *
 * Lives here rather than beside the action schemas because a client component needs it as a
 * *value*, and the schema module is `server-only`.
 */
export const PROJECT_ATTACHMENT_ROLES = ["before", "after", "receipt", "document"] as const;
export type ProjectAttachmentRole = (typeof PROJECT_ATTACHMENT_ROLES)[number];

export const PROJECT_ATTACHMENT_ROLE_LABEL: Record<ProjectAttachmentRole, string> = {
  before: "Before",
  after: "After",
  receipt: "Receipt",
  document: "Document",
};

export const PROJECT_ATTACHMENT_ROLE_HELP: Record<ProjectAttachmentRole, string> = {
  before: "How it looked before the work started.",
  after: "How it looked when the work was finished.",
  receipt: "What it cost, as issued.",
  document: "Permits, inspection reports, drawings, guarantees.",
};

const EUR = new Intl.NumberFormat("fi-FI", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
});

/** Cents → "1 234,50 €". `null` becomes an em dash, never "0,00 €": unknown is not zero. */
export function formatCents(cents: number | null | undefined, currency = "EUR"): string {
  if (cents === null || cents === undefined) return "—";
  if (currency !== "EUR")
    return `${(cents / 100).toFixed(2)} ${currency}`;
  return EUR.format(cents / 100);
}

/**
 * "1 234,50", "1.234,50 €", "1234.5" → 123450. Returns `null` for anything it cannot read, so the
 * form can say "that is not an amount" instead of silently storing a zero.
 *
 * Integer arithmetic on the digit strings, never `Math.round(value * 100)`.
 */
export function parseCents(raw: string): number | null {
  const text = raw.replace(/[\s €]/g, "");
  if (text === "") return null;
  // Whichever separator appears last is the decimal one; the other is a thousands separator.
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const decimalAt = Math.max(lastComma, lastDot);
  const hasDecimal = decimalAt >= 0 && text.length - decimalAt - 1 <= 2;
  const whole = (hasDecimal ? text.slice(0, decimalAt) : text).replace(/[.,]/g, "");
  const fraction = hasDecimal ? text.slice(decimalAt + 1) : "";
  if (!/^-?\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  if (whole === "" || whole === "-") return null;
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const cents = Number(digits) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2) || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * Budget vs actual, stated as a difference rather than a percentage: "€ 240 over" is actionable,
 * "12 % over" invites arguing about the denominator. `null` when either side is unknown.
 */
export function costVariance(
  budgetCents: number | null,
  actualCostCents: number | null,
): { overspend: boolean; deltaCents: number } | null {
  if (budgetCents === null || actualCostCents === null) return null;
  const deltaCents = actualCostCents - budgetCents;
  return { overspend: deltaCents > 0, deltaCents: Math.abs(deltaCents) };
}

/**
 * The "Show in house" target.
 *
 * `?project=<id>` is the intended filter (routes and placements linked to this project); the
 * workspace does not read it yet, so a `?sel=route:<id>` is appended when the project has a route
 * to select, which makes the link do something real today rather than just open the workspace.
 * Recorded as a follow-up in `docs/model-contract.md`.
 */
export function showInHouseHref(projectId: string, routeIds: readonly string[]): string {
  const base = `/house?project=${encodeURIComponent(projectId)}`;
  const first = routeIds[0];
  return first ? `${base}&sel=route:${encodeURIComponent(first)}` : base;
}
