/**
 * The bridge between what the workspace draws and what the database stores.
 *
 * `infra_route.medium` is the persisted fact ("hot water", "extract air", "Cat6a"). The 3D
 * workspace's `Route.system` / `Route.kind` are *presentation* categories — they pick a hue and a
 * glyph — and the client type has no medium field at all. So the mapping runs one way for free
 * (a medium always has exactly one system and one kind) and needs care in the other:
 * `mediumForSystem` is given the medium already on the row and keeps it whenever it still belongs
 * to the chosen system, so editing a route's name in the workspace cannot silently turn hot water
 * into cold water.
 *
 * `Route.kind` is not stored anywhere: it is derived here. That is listed in the endpoint's
 * `partialFields` rather than hidden, because a "valve" drawn as a pipe is a fact the user should
 * see stated.
 */
import type { InfraMedium } from "@/db/schema/infrastructure";
import type { RouteKind, RouteSystem } from "@/house/model/types";

/** Which functional system a medium belongs to. Total, and the only direction that is lossless. */
export const SYSTEM_OF_MEDIUM: Record<InfraMedium, RouteSystem> = {
  cold_water: "water",
  hot_water: "water",
  waste: "drainage",
  supply_air: "ventilation",
  extract_air: "ventilation",
  electricity: "electrical",
  ethernet: "network",
  fiber: "network",
  coax: "network",
  gas: "other",
  heating_water: "heating",
  drain: "drainage",
};

/** What the run physically is. Drawn width/dash come from elsewhere; this is only the noun. */
export const KIND_OF_MEDIUM: Record<InfraMedium, RouteKind> = {
  cold_water: "pipe",
  hot_water: "pipe",
  waste: "pipe",
  supply_air: "duct",
  extract_air: "duct",
  electricity: "cable",
  ethernet: "cable",
  fiber: "cable",
  coax: "cable",
  gas: "pipe",
  heating_water: "pipe",
  drain: "pipe",
};

/**
 * The medium assumed when all the caller knows is the system. `other → gas` is the one arbitrary
 * pick, chosen so that the round trip `other → gas → other` is stable.
 */
export const DEFAULT_MEDIUM_OF_SYSTEM: Record<RouteSystem, InfraMedium> = {
  ventilation: "supply_air",
  water: "cold_water",
  electrical: "electricity",
  network: "ethernet",
  heating: "heating_water",
  drainage: "waste",
  other: "gas",
};

export const MEDIUM_LABELS: Record<InfraMedium, string> = {
  cold_water: "Cold water",
  hot_water: "Hot water",
  waste: "Waste water",
  supply_air: "Supply air",
  extract_air: "Extract air",
  electricity: "Electricity",
  ethernet: "Ethernet",
  fiber: "Fibre",
  coax: "Coax",
  gas: "Gas",
  heating_water: "Heating water",
  drain: "Drain",
};

export const systemOfMedium = (medium: InfraMedium): RouteSystem => SYSTEM_OF_MEDIUM[medium];
export const kindOfMedium = (medium: InfraMedium): RouteKind => KIND_OF_MEDIUM[medium];

/** Every medium that belongs to a system, in declaration order. */
export function mediaOfSystem(system: RouteSystem): InfraMedium[] {
  return (Object.keys(SYSTEM_OF_MEDIUM) as InfraMedium[]).filter(
    (m) => SYSTEM_OF_MEDIUM[m] === system,
  );
}

/**
 * The medium to store for a route whose caller only stated a `system`.
 *
 * `previous` is the medium already on the row. Keeping it whenever it still belongs to `system` is
 * what makes a workspace round trip lossless: a `hot_water` route saved back as `system: 'water'`
 * stays hot water instead of collapsing to the system default.
 */
export function mediumForSystem(
  system: RouteSystem,
  previous?: InfraMedium | null,
): InfraMedium {
  if (previous && SYSTEM_OF_MEDIUM[previous] === system) return previous;
  return DEFAULT_MEDIUM_OF_SYSTEM[system];
}
