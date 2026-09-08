/**
 * Words and status mapping for the equipment screens. Pure and React-free.
 */
import type {
  AssetCategory,
  AssetStatus,
  ConsumableRole,
  HaLinkRole,
  HaLinkState,
  ReplacementReason,
  SystemKind,
  SystemStatus,
} from "@/db/schema";
import type { BadgeTone } from "@/ui";

export const CATEGORY_LABEL: Record<AssetCategory, string> = {
  appliance: "Appliance",
  hvac: "Heating & ventilation",
  plumbing: "Plumbing",
  electrical: "Electrical",
  network: "Network",
  safety: "Safety",
  structure: "Structure",
  outdoor: "Outdoor",
  vehicle: "Vehicle",
  software: "Software",
  other: "Other",
};

export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  planned: "Planned",
  installed: "In service",
  removed: "Removed",
  retired: "Retired",
  lost: "Lost",
};

/**
 * Equipment status is not maintenance status: `installed` is the normal state and gets a neutral
 * badge, not a green tick. A green tick here would claim something about maintenance that this
 * column does not know.
 */
export const ASSET_STATUS_TONE: Record<AssetStatus, BadgeTone> = {
  planned: "neutral",
  installed: "accent",
  removed: "neutral",
  retired: "neutral",
  lost: "overdue",
};

export const CONSUMABLE_ROLE_LABEL: Record<ConsumableRole, string> = {
  battery: "Battery",
  filter: "Filter",
  bag: "Bag",
  belt: "Belt",
  lamp: "Lamp",
  fluid: "Fluid",
  seal: "Seal",
  other: "Other",
};

export const HA_LINK_ROLE_LABEL: Record<HaLinkRole, string> = {
  primary: "Primary",
  battery_level: "Battery level",
  power: "Power",
  status: "Status",
  control: "Control",
  diagnostic: "Diagnostic",
  other: "Other",
};

export const HA_LINK_ROLE_HELP: Record<HaLinkRole, string> = {
  primary: "The entity that best represents this unit. One per unit.",
  battery_level: "The battery percentage the low-battery rule watches. One per unit.",
  power: "Power draw or a switch that cuts power.",
  status: "A binary or enumerated state: filter clogged, door open, error code.",
  control: "Something the household actually operates from Home Assistant.",
  diagnostic: "Kept for reference; not shown as a headline figure.",
  other: "Anything that does not fit the roles above.",
};

export interface LinkStateMeta {
  label: string;
  tone: BadgeTone;
  explanation: string;
}

/**
 * The four states a human has to act on, plus `retired`. `renamed` is explicitly *not* a failure:
 * every link stores the registry id, so a rename in Home Assistant changes nothing but the label
 * we cached — the badge says so rather than crying wolf.
 */
export const LINK_STATE_META: Record<HaLinkState, LinkStateMeta> = {
  active: {
    label: "Linked",
    tone: "ok",
    explanation: "The registry entry this link points at is present in the cached registry.",
  },
  renamed: {
    label: "Renamed in HA",
    tone: "neutral",
    explanation:
      "The entity id changed in Home Assistant. Nothing broke — the link stores the registry id — but the label we show is from before the rename.",
  },
  missing: {
    label: "Missing in HA",
    tone: "overdue",
    explanation:
      "The registry entry is gone from Home Assistant. Condition rules on it stopped evaluating; relink it or remove the link.",
  },
  replaced: {
    label: "Replaced",
    tone: "neutral",
    explanation:
      "This link belonged to a unit that was replaced. It is kept as history and is not evaluated.",
  },
  retired: {
    label: "Retired",
    tone: "neutral",
    explanation: "Deliberately switched off. Not evaluated, kept for the record.",
  },
};

export const REPLACEMENT_REASON_LABEL: Record<ReplacementReason, string> = {
  failure: "It failed",
  end_of_life: "End of life",
  upgrade: "Upgrade",
  damage: "Damaged",
  recall: "Recall",
  other: "Other",
};

export const SYSTEM_KIND_LABEL: Record<SystemKind, string> = {
  ventilation: "Ventilation",
  water: "Water",
  wastewater: "Wastewater",
  heating: "Heating",
  electrical: "Electrical",
  networking: "Networking",
  security: "Security",
  irrigation: "Irrigation",
  other: "Other",
};

export const SYSTEM_STATUS_LABEL: Record<SystemStatus, string> = {
  active: "Active",
  decommissioned: "Decommissioned",
};

/** Deep-link into the 3D workspace with this asset selected. */
export function locateInHouseHref(assetId: string): string {
  return `/house?sel=asset:${encodeURIComponent(assetId)}`;
}

/**
 * The `attachment_link.role` vocabulary for files attached to equipment (`entityKind: 'asset'`).
 * Free text in the schema, but small and closed in practice, so the action and the UI both import
 * this list rather than each spelling it out.
 *
 * `close_up` is what "Where to find it" shows as a photo gallery; `manual` / `nameplate` /
 * `document` are what "Manuals & documents" offers when attaching a file; `photo` is a general,
 * non-close-up photo the action accepts but this page has no dedicated upload control for yet.
 */
export const ASSET_ATTACHMENT_ROLES = ["close_up", "manual", "nameplate", "document", "photo"] as const;
export type AssetAttachmentRole = (typeof ASSET_ATTACHMENT_ROLES)[number];

export const ASSET_ATTACHMENT_ROLE_LABEL: Record<AssetAttachmentRole, string> = {
  close_up: "Close-up photo",
  manual: "Manual",
  nameplate: "Nameplate",
  document: "Document",
  photo: "Photo",
};

/** Roles offered by the "Manuals & documents" upload control. */
export const ASSET_DOCUMENT_ROLES = ["manual", "nameplate", "document"] as const satisfies readonly AssetAttachmentRole[];
