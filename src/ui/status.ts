/**
 * The app's six status kinds and their presentation. Pure data — no React —
 * so the worker, tests and server components can use it too.
 *
 * Rule: colour is never the only carrier of meaning. Every kind has a distinct
 * glyph (`icon`) and a human label, and `Badge`/`StatusDot` always render at
 * least one of them.
 */
export const STATUS_KINDS = ["ok", "due", "overdue", "blocked", "unknown", "stale"] as const;

export type StatusKind = (typeof STATUS_KINDS)[number];

/** Glyph identifiers; `Badge`/`StatusDot` map these to lucide components. */
export type StatusIcon = "check" | "clock" | "alert" | "ban" | "question" | "cloud-off";

export interface StatusMeta {
  readonly kind: StatusKind;
  /** Short, sentence-case label shown to the user. */
  readonly label: string;
  /** One line explaining what the state means, for tooltips and help text. */
  readonly description: string;
  /** Which glyph identifies this kind. Distinct per kind by design. */
  readonly icon: StatusIcon;
  /** Tailwind classes for the strong (foreground) colour token. */
  readonly fg: string;
  /** Tailwind classes for the soft (background) colour token. */
  readonly bg: string;
  /** Tailwind classes for a border in the strong colour at low opacity. */
  readonly border: string;
}

const META: { readonly [K in StatusKind]: StatusMeta } = {
  ok: {
    kind: "ok",
    label: "Up to date",
    description: "Nothing is due; the last completion is within the interval.",
    icon: "check",
    fg: "text-ok",
    bg: "bg-ok-soft",
    border: "border-ok/30",
  },
  due: {
    kind: "due",
    label: "Due",
    description: "Due now or within the household's lead time.",
    icon: "clock",
    fg: "text-due",
    bg: "bg-due-soft",
    border: "border-due/30",
  },
  overdue: {
    kind: "overdue",
    label: "Overdue",
    description: "The due date has passed and no completion was recorded.",
    icon: "alert",
    fg: "text-overdue",
    bg: "bg-overdue-soft",
    border: "border-overdue/30",
  },
  blocked: {
    kind: "blocked",
    label: "Blocked",
    description: "Cannot proceed: a supply is missing or a professional is booked.",
    icon: "ban",
    fg: "text-blocked",
    bg: "bg-blocked-soft",
    border: "border-blocked/30",
  },
  unknown: {
    kind: "unknown",
    label: "Unknown",
    description: "No data. Never a value — not zero, not \"fine\".",
    icon: "question",
    fg: "text-unknown",
    bg: "bg-unknown-soft",
    border: "border-unknown/30",
  },
  stale: {
    kind: "stale",
    label: "Stale",
    description: "The last reading is too old to trust; showing it would mislead.",
    icon: "cloud-off",
    fg: "text-stale",
    bg: "bg-stale-soft",
    border: "border-stale/30",
  },
};

/** Presentation for a status kind. Total function — every kind has an entry. */
export function statusMeta(kind: StatusKind): StatusMeta {
  return META[kind];
}

/** Narrow an untrusted value (URL param, HA attribute) to a StatusKind. */
export function isStatusKind(value: unknown): value is StatusKind {
  return typeof value === "string" && (STATUS_KINDS as readonly string[]).includes(value);
}

/** Narrow an untrusted value, falling back to `unknown` rather than throwing. */
export function toStatusKind(value: unknown): StatusKind {
  return isStatusKind(value) ? value : "unknown";
}

/**
 * Order used when a list is sorted by urgency (most urgent first). `unknown`
 * ranks above `ok`: missing information is a thing to look at, not a pass.
 */
export const STATUS_URGENCY: readonly StatusKind[] = [
  "overdue",
  "due",
  "blocked",
  "stale",
  "unknown",
  "ok",
];

/** Comparator for `Array.prototype.sort`, most urgent first. */
export function compareStatusUrgency(a: StatusKind, b: StatusKind): number {
  return STATUS_URGENCY.indexOf(a) - STATUS_URGENCY.indexOf(b);
}

/* -------------------------------------------------------------------------- */
/* Home Assistant connection                                                   */
/* -------------------------------------------------------------------------- */

export const CONNECTION_STATES = [
  "connected",
  "degraded",
  "disconnected",
  "unknown",
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

export interface ConnectionMeta {
  readonly state: ConnectionState;
  readonly label: string;
  readonly description: string;
  /** Which status colour this connection state borrows. */
  readonly kind: StatusKind;
}

const CONNECTION_META: { readonly [S in ConnectionState]: ConnectionMeta } = {
  connected: {
    state: "connected",
    label: "Home Assistant",
    description: "Connected; entity states are live.",
    kind: "ok",
  },
  degraded: {
    state: "degraded",
    label: "HA degraded",
    description: "Connected but behind: some entities are stale or unavailable.",
    kind: "stale",
  },
  disconnected: {
    state: "disconnected",
    label: "HA offline",
    description: "No connection. Sensor values are not shown, not guessed.",
    kind: "overdue",
  },
  unknown: {
    state: "unknown",
    label: "HA unknown",
    description: "The worker has not reported a connection state yet.",
    kind: "unknown",
  },
};

export function connectionMeta(state: ConnectionState): ConnectionMeta {
  return CONNECTION_META[state];
}

/**
 * The single mapping from `integration_status.state` (plus "is the worker alive") onto the pill.
 *
 * There is exactly one of these on purpose. The header pill and `/settings/home-assistant` sit in
 * the same viewport, and two independent derivations meant the two pills disagreed about the same
 * row — one calling a dead worker `disconnected` while the other called it `unknown`.
 *
 * A dead worker is `unknown`, not `disconnected`: nobody has observed Home Assistant at all, and
 * claiming it is disconnected would assert something nothing measured (rule 8). `connecting`,
 * `authenticating` and `syncing` are `degraded`: the worker *is* reporting, and the link is
 * genuinely part-way up rather than unobserved.
 *
 * The parameter is typed structurally rather than against `IntegrationState` so this module stays
 * free of database imports; `IntegrationState` is assignable to it, and the switch is exhaustive.
 */
export type IntegrationStateName =
  | "connecting"
  | "authenticating"
  | "syncing"
  | "subscribed"
  | "degraded"
  | "auth_failed"
  | "disconnected";

export function connectionStateOf(
  state: IntegrationStateName | null,
  workerRunning: boolean,
): ConnectionState {
  if (state === null || !workerRunning) return "unknown";
  switch (state) {
    case "subscribed":
      return "connected";
    case "connecting":
    case "authenticating":
    case "syncing":
    case "degraded":
      return "degraded";
    case "auth_failed":
    case "disconnected":
      return "disconnected";
  }
}

export function isConnectionState(value: unknown): value is ConnectionState {
  return typeof value === "string" && (CONNECTION_STATES as readonly string[]).includes(value);
}

export function toConnectionState(value: unknown): ConnectionState {
  return isConnectionState(value) ? value : "unknown";
}
