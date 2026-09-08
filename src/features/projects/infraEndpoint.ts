/**
 * Words for `infra_endpoint.kind`.
 *
 * The enum is short and the words are not obvious — "terminal" is what a plumber calls the tap and
 * what a ventilation fitter calls the vent — so each kind carries a sentence of help as well as a
 * label. The help text is what stops a shutoff being recorded as a junction, which is the
 * difference between "where do I turn the water off" being answerable and not.
 *
 * `ASSET_CATEGORY_LABEL` sits here too because the only place the house workspace offers an asset
 * category is the endpoint form's "create the equipment for this" bridge.
 */
import type { AssetCategory } from "@/db/schema/assets";
import type { InfraEndpointKind } from "@/db/schema/infrastructure";

export const ENDPOINT_KIND_LABEL: Record<InfraEndpointKind, string> = {
  source: "Source",
  terminal: "Terminal (inlet, outlet, tap)",
  junction: "Junction",
  meter: "Meter",
  shutoff: "Shutoff",
  panel: "Panel",
  patch_port: "Patch port",
};

/** The one-word form, for list rows where the parenthetical would crowd everything else out. */
export const ENDPOINT_KIND_SHORT: Record<InfraEndpointKind, string> = {
  source: "Source",
  terminal: "Terminal",
  junction: "Junction",
  meter: "Meter",
  shutoff: "Shutoff",
  panel: "Panel",
  patch_port: "Patch port",
};

export const ENDPOINT_KIND_HELP: Record<InfraEndpointKind, string> = {
  source: "Where the medium enters the house or is produced — the main inlet, the boiler, the HRU.",
  terminal:
    "Where it is delivered or taken away: a supply-air inlet, an extract vent, a tap, a socket.",
  junction: "A tee, a manifold, a splice — a place runs meet and can be opened up.",
  meter: "Something that counts: the water meter, the electricity meter, a sub-meter.",
  shutoff: "A valve or breaker somebody has to find in a hurry.",
  panel: "A distribution board or cabinet.",
  patch_port: "One numbered port on a patch panel.",
};

/**
 * The kinds a duct, pipe or cable typically *ends* at, offered first in the form. Not a rule —
 * every kind stays selectable — just the order that makes the common case one click.
 */
export const ENDPOINT_KIND_ORDER: readonly InfraEndpointKind[] = [
  "terminal",
  "source",
  "shutoff",
  "meter",
  "panel",
  "junction",
  "patch_port",
];

export const ASSET_CATEGORY_LABEL: Record<AssetCategory, string> = {
  appliance: "Appliance",
  hvac: "HVAC",
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
