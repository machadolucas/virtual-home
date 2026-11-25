export type FrameArea = "House" | "Yard" | "Garage" | "Mixed reality" | "Room survey";
export interface TimingRow {
  area: FrameArea;
  samples: number;
  p95Ms: number;
  hz: number;
  missedPercent: number;
}
interface SampleBin {
  counts: Uint32Array;
  samples: number;
  late: number;
  hz: number;
}
export const timingEvent = "vh-xr-frame-timing";
export function timingKey(userId?: string) {
  return "vh.xr.timing." + encodeURIComponent(userId ?? "local");
}

/** A bounded histogram; no position, room name or tracking data is retained. */
export class FrameLog {
  private areas = new Map<FrameArea, SampleBin>();
  sample(area: FrameArea, ms: number, hz: number) {
    if (ms <= 0 || ms > 500) return;
    let bin = this.areas.get(area);
    if (!bin) this.areas.set(area, (bin = { counts: new Uint32Array(251), samples: 0, late: 0, hz }));
    bin.counts[Math.min(250, Math.round(ms * 2))]!++;
    bin.samples++;
    bin.hz = hz;
    if (ms > (1.35 * 1000) / hz) bin.late++;
  }
  save(userId?: string) {
    const rows: TimingRow[] = [];
    for (const [area, bin] of this.areas) {
      let sum = 0,
        i = 0;
      for (; i < bin.counts.length; i++) {
        sum += bin.counts[i]!;
        if (sum >= bin.samples * 0.95) break;
      }
      rows.push({
        area,
        samples: bin.samples,
        hz: bin.hz,
        p95Ms: i / 2,
        missedPercent: Math.round((1000 * bin.late) / bin.samples) / 10,
      });
    }
    if (!rows.length) return;
    try {
      localStorage.setItem(timingKey(userId), JSON.stringify(rows));
      window.dispatchEvent(new Event(timingEvent));
    } catch {
      /* device storage is optional */
    }
  }
}
