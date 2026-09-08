/**
 * Battery display for the equipment screens.
 *
 * This module exists to enforce one hard rule (CLAUDE.md #8): **`unknown`/`unavailable` is never a
 * value, and never 0 %.** A smoke alarm whose battery entity has not reported is not a smoke alarm
 * with a flat battery — it is a smoke alarm we know nothing about, and the two need different
 * reactions from a human.
 *
 * So `batteryDisplay` returns a discriminated result rather than a number, and there is no code
 * path that turns a missing reading into a percentage. Pure and React-free: the list, the detail
 * page and the export all read the same function.
 */
import type { StatusKind } from "@/ui/status";

/** What the caller has been able to find out about one asset's battery. */
export interface BatteryInput {
  /**
   * The raw state string from `ha_entity_state.state` / `condition_signal.raw_state`, verbatim.
   * `null` means there is no cached reading at all (no link, or nothing observed yet).
   */
  rawState: string | null;
  /** HA's `last_updated`, epoch ms. `null` when there is no reading. */
  lastUpdatedMs: number | null;
  /** `condition_signal.is_stale`, when the condition engine has already judged it. */
  isStale?: boolean;
  /** `household_setting.battery_threshold_pct` — below this the battery is worth acting on. */
  thresholdPct: number;
  /** `household_setting.battery_stale_hours` — older than this and the reading is not trusted. */
  staleHours: number;
  /** Evaluation instant, injected so this stays testable. */
  nowMs: number;
}

export type BatteryDisplay =
  | {
      /** A number we are willing to show. */
      state: "value";
      percent: number;
      /** `low` when at or under the household threshold. */
      low: boolean;
      status: StatusKind;
      label: string;
    }
  | {
      /** We have a reading but it is too old to believe. */
      state: "stale";
      /** The last value, shown as history rather than as the current level. */
      percent: number | null;
      status: "stale";
      label: string;
    }
  | {
      /** No reading, a non-numeric reading, or HA saying `unknown`/`unavailable`. */
      state: "unknown";
      status: "unknown";
      label: string;
      /** Why, in one word, for a tooltip: `no_link`, `unavailable`, `unknown`, `non_numeric`. */
      reason: "no_link" | "unavailable" | "unknown" | "non_numeric";
    };

const NON_VALUES = new Set(["", "none", "null", "nan", "unknown", "unavailable"]);

/**
 * Interpret one battery reading.
 *
 * Note what is *not* here: no default of 0, no `?? 0`, no `Number(state) || 0`. Every branch that
 * cannot produce a real percentage produces `unknown` or `stale`, and both render as words.
 */
export function batteryDisplay(input: BatteryInput): BatteryDisplay {
  const { rawState, lastUpdatedMs, thresholdPct, staleHours, nowMs } = input;

  if (rawState === null) {
    return { state: "unknown", status: "unknown", label: "Battery unknown", reason: "no_link" };
  }

  const trimmed = rawState.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered === "unavailable") {
    return { state: "unknown", status: "unknown", label: "Battery unknown", reason: "unavailable" };
  }
  if (lowered === "unknown" || NON_VALUES.has(lowered)) {
    return { state: "unknown", status: "unknown", label: "Battery unknown", reason: "unknown" };
  }

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    return { state: "unknown", status: "unknown", label: "Battery unknown", reason: "non_numeric" };
  }

  const percent = Math.round(parsed);
  const staleByAge =
    lastUpdatedMs !== null && nowMs - lastUpdatedMs > staleHours * 3_600_000;
  if (input.isStale === true || staleByAge) {
    return {
      state: "stale",
      percent,
      status: "stale",
      label: `Last read ${percent} %`,
    };
  }

  const low = percent <= thresholdPct;
  return {
    state: "value",
    percent,
    low,
    status: low ? "due" : "ok",
    label: `${percent} %`,
  };
}

/**
 * A battery column value for a dense table: the label plus the status kind, so the row carries a
 * glyph and never colour alone.
 */
export function batteryCell(display: BatteryDisplay): { label: string; status: StatusKind } {
  return { label: display.label, status: display.status };
}
