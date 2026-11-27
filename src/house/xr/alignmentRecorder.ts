import type { CalibrationPair } from "./mixedCalibration";
import type { AlignmentAttemptEvent, AlignmentAttempt, AlignmentAttemptSnapshot } from "../alignmentAttemptTypes";
import { queueAlignmentAttempt, uploadAlignmentAttempt } from "../alignmentAttemptApi";

const CHECKPOINT_MS = 4_000;
type Observation = Omit<AlignmentAttemptSnapshot, "atMs" | "roomId" | "space">;

export class AlignmentRecorder {
  readonly report: AlignmentAttempt;
  private space = 0;
  private nextSample = 0;
  private lastShape = "";
  private acknowledged = 0;
  private active = false;
  private locallySaved = false;
  private failed = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retryMs = CHECKPOINT_MS;
  private lastMessage = new Map<string, string>();
  constructor(private base: string, userId: string, fingerprint: string, mode: AlignmentAttempt["mode"], features: readonly string[]) {
    this.report = {id: crypto.randomUUID(), revision: 0, userId, fingerprint, mode, status: "aligning",
      startedAtMs: Date.now(), elapsedMs: 0, roomId: null, snapshots: [], events: [],
      features: features.filter(f => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(f)).slice(0,32)};
    this.event("started", "Room discovery started.");
    window.addEventListener("pagehide", this.onHide);
    window.addEventListener("online", this.onOnline);
  }
  private get elapsed() { return Math.min(7 * 86_400_000, Math.max(this.report.elapsedMs, Date.now() - this.report.startedAtMs)); }
  get notice() {
    if (this.acknowledged >= this.report.revision) return "Alignment report saved";
    if (!this.failed) return "Saving alignment report…";
    return this.locallySaved ? "Report saved on headset · waiting to sync" : "Alignment report could not be saved";
  }
  selectRoom(id: string | null) {
    this.report.roomId = id;
    this.report.status = "aligning";
    this.nextSample = 0;
    this.lastShape = "";
    this.lastMessage.clear();
    this.event("room", id ?? "Room chooser opened.");
  }
  mark(pair: CalibrationPair, first?: CalibrationPair) {
    const roomId = this.report.roomId;
    if (!roomId) return;
    const mm = (n: number) => Math.round(n * 1000) / 1000;
    const rounded = ([x,y,z]: CalibrationPair["observed"]): [number,number,number] => [mm(x),mm(y),mm(z)];
    let detail = `Measured ${pair.feature.label}.`;
    if (first) {
      const model = pair.feature.point, base = first.feature.point;
      const observed = pair.observed, start = first.observed;
      const span = (a: typeof base, b: typeof base) => Math.hypot(a[0]-b[0], a[2]-b[2]).toFixed(2);
      detail += ` From ${first.feature.label}, horizontal span ${span(observed,start)} m measured, ${span(model,base)} m modeled.`
        + ` Height change ${(observed[1]-start[1]).toFixed(2)} m measured, ${(model[1]-base[1]).toFixed(2)} m modeled.`;
    }
    this.event("measured-feature", detail, {space:this.space, roomId, featureId:pair.feature.id,
      modeled:rounded(pair.feature.point), observed:rounded(pair.observed)});
  }
  event(kind: string, detail: string, measurement?: AlignmentAttemptEvent["measurement"]) {
    if (this.closed || (!measurement && this.lastMessage.get(kind) === detail)) return;
    this.lastMessage.set(kind, detail);
    this.report.events.push({atMs:this.elapsed, kind, detail:detail.slice(0,320), ...(measurement && {measurement})});
    if (this.report.events.length > 48) this.report.events.splice(1,1);
    this.changed();
  }
  interrupt(kind: string) {
    if (this.closed || (this.report.status === "interrupted" && kind !== "reference-reset")) return;
    this.space++;
    this.report.status = "interrupted";
    this.nextSample = 0;
    this.lastShape = "";
    this.lastMessage.clear();
    this.event(kind, "Alignment tracking interrupted.");
    this.flush();
  }
  observe(read: () => Observation, force = false) {
    if (this.closed || this.report.status === "aligned" || (!force && this.elapsed < this.nextSample)) return;
    if (this.report.status === "interrupted") {
      this.report.status = "aligning";
      this.event("resumed","Tracking resumed.");
    }
    this.nextSample = this.elapsed + CHECKPOINT_MS;
    const observed = read();
    // Do not create a sequence of head positions while the geometry and result stay the same.
    const signature = JSON.stringify({...observed,viewer:undefined});
    if (this.lastShape === signature) return;
    this.lastShape = signature;
    const samples = this.report.snapshots;
    if (samples.length >= 4) {
      // Keep the most informative earlier observation through an empty frame or a reference reset.
      const score = (s: AlignmentAttemptSnapshot) => s.walls.length + s.landmarks.length * 3 +
        s.traces.length * 4 + (s.floor ? 2 : 0) + (s.diagnosis?.bestCheckM != null ? 2 : 0);
      const best = samples.reduce((winner,s,i) => score(s) > score(samples[winner]!) ? i : winner,0);
      samples.splice(best === 0 ? 1 : 0,1);
    }
    samples.push({...observed,roomId:this.report.roomId,space:this.space,atMs:this.elapsed});
    this.changed();
  }
  aligned(message: string) {
    if (this.report.status === "aligned") return;
    this.report.status = "aligned";
    this.event("aligned", message);
    this.flush();
  }
  private changed() {
    this.report.elapsedMs = this.elapsed;
    this.report.revision++;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 350);
  }
  private onOnline = () => this.flush();
  private onHide = () => this.flush(true);
  private flush(closing = false) {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.acknowledged >= this.report.revision) return;
    this.locallySaved = queueAlignmentAttempt(this.base,this.report);
    if (this.active) return;
    this.active = true;
    const checkpoint = {...this.report};
    void uploadAlignmentAttempt(this.base, checkpoint, closing).then(revision => {
      this.acknowledged = Math.max(this.acknowledged, revision);
      this.failed = false; this.retryMs = CHECKPOINT_MS;
    }).catch(() => { this.failed = true; }).finally(() => {
      this.active = false;
      if (this.acknowledged >= this.report.revision) return;
      if (checkpoint.revision < this.report.revision) this.flush(this.closed || closing);
      else if (!this.closed) {
        this.timer = setTimeout(() => this.flush(), this.retryMs);
        this.retryMs = Math.min(60_000, this.retryMs * 2);
      }
    });
  }
  finish() {
    if (this.closed) return;
    if (this.report.status === "aligning") this.report.status = "ended";
    this.event("ended", "Immersive session ended.");
    this.closed = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("pagehide", this.onHide);
    this.flush(true);
  }
}
