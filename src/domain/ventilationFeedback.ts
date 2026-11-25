import { z } from "zod";
import type { AirStream } from "./airStream";

export const VENTILATION_FANS = ["supply", "extract"] as const;
export type VentilationFan = (typeof VENTILATION_FANS)[number];

const registryId = z.string().trim().min(1).max(250).nullable();
export const ventilationFeedbackSchema = z.object({
  supply: registryId,
  extract: registryId,
  // Change-only sensors can keep HA's report time unchanged while the source is readable.
  staleAfterSeconds: z.union([z.literal(0), z.number().int().min(30).max(86_400)]),
}).refine(({ supply, extract }) => !supply || supply !== extract, {
  message: "Supply and extract require separate sensor entities.",
});

export type VentilationFeedbackConfig = z.infer<typeof ventilationFeedbackSchema>;
export const DEFAULT_FEEDBACK_STALE_SECONDS = 180;
export const EMPTY_VENTILATION_FEEDBACK: VentilationFeedbackConfig = {
  supply: null,
  extract: null,
  staleAfterSeconds: DEFAULT_FEEDBACK_STALE_SECONDS,
};

export const VENTILATION_POLL_MS = 20_000;
const FEEDBACK_LINK_TIMEOUT_MS = VENTILATION_POLL_MS * 3 + 5_000;

export const fanForAirStream = (stream: AirStream): VentilationFan =>
  stream === "outdoor_intake" || stream === "room_supply" ? "supply" : "extract";

export type VentilationFeedback =
  | { status: "illustrative" | "disconnected" | "unavailable" | "unknown" | "stale" | "invalid" }
  | { status: "live" | "stopped"; percentage: number };

export interface VentilationReading {
  state: string;
  unit?: string | null;
  lastUpdated: number;
  lastReported?: number | null;
  observedAt?: number | null;
}

export function classifyVentilationFeedback(
  config: VentilationFeedbackConfig,
  fan: VentilationFan,
  reading: VentilationReading | undefined,
  connected: boolean,
  now: number,
): VentilationFeedback {
  if (!config[fan]) return { status: "illustrative" };
  if (!connected) return { status: "disconnected" };
  if (!reading) return { status: "unavailable" };
  if (reading.observedAt == null || now - reading.observedAt >= FEEDBACK_LINK_TIMEOUT_MS) {
    return { status: "disconnected" };
  }
  if (reading.state === "unavailable") return { status: "unavailable" };
  if (reading.state === "unknown") return { status: "unknown" };
  const maxReportAgeMs = config.staleAfterSeconds * 1000;
  if (maxReportAgeMs > 0 && now - (reading.lastReported ?? reading.lastUpdated) >= maxReportAgeMs) {
    return { status: "stale" };
  }

  const raw = reading.state.trim();
  const percentage = Number(raw);
  if (!/^\d*\.?\d+(?:e[+-]?\d+)?$/i.test(raw) || percentage < 0 || percentage > 100 ||
      reading.unit?.trim() !== "%") {
    return { status: "invalid" };
  }
  return { status: percentage === 0 ? "stopped" : "live", percentage };
}
