/**
 * Small formatters the settings pages share. Pure, React-free, locale-independent on purpose:
 * these strings end up in exports and in copy-as-text blocks as often as on screen.
 */

/** `1536` -> `"1.5 kB"`. Decimal units, because that is what `df` and the backup log report. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"] as const;
  let value = bytes / 1000;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

/**
 * A coarse age: `"just now"`, `"4 min ago"`, `"3 h ago"`, `"2 days ago"`.
 *
 * Returns `null` for a missing instant rather than "never" — the caller decides whether "never"
 * or "unknown" is the honest word, and those are different things (a backup that never ran versus
 * a backup log we cannot read).
 */
export function formatAge(atMs: number | null, nowMs: number): string | null {
  if (atMs === null) return null;
  const delta = nowMs - atMs;
  if (delta < 0) return "in the future";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** ISO-8601 UTC, for the "exact instant" line under a coarse age. */
export function isoOf(atMs: number | null): string | null {
  return atMs === null ? null : new Date(atMs).toISOString();
}

/** One sample of `process_metric`, in the order the query returns them (oldest first). */
export interface MetricSample {
  atMs: number;
  rssBytes: number;
}

export interface Sparkline {
  /** SVG `points` attribute for a `<polyline>`, in a 0..width by 0..height box. */
  points: string;
  /** Highest RSS in the window, for the axis label. */
  peakBytes: number;
  /** Most recent RSS, for the headline figure. */
  lastBytes: number;
  sampleCount: number;
}

/**
 * Build a plain SVG polyline from memory samples. No charting library, no animation — the UX rules
 * forbid decorative charts, and this is the one place a shape carries information a number cannot
 * (a sawtooth means restarts; a ramp means a leak).
 *
 * Returns `null` for fewer than two samples: a single point is not a trend, and drawing it as a
 * flat line would imply a stability we have not observed.
 */
export function memorySparkline(
  samples: readonly MetricSample[],
  width: number,
  height: number,
): Sparkline | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const spanMs = Math.max(1, last.atMs - first.atMs);
  const peakBytes = samples.reduce((max, sample) => Math.max(max, sample.rssBytes), 0);
  // Baseline at zero rather than at the minimum: a y-axis that starts at the minimum turns 2 % of
  // noise into a dramatic mountain range, which is exactly the fake drama the UX rules ban.
  const scale = peakBytes === 0 ? 0 : height / peakBytes;
  const points = samples
    .map((sample) => {
      const x = ((sample.atMs - first.atMs) / spanMs) * width;
      const y = height - sample.rssBytes * scale;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return { points, peakBytes, lastBytes: last.rssBytes, sampleCount: samples.length };
}
