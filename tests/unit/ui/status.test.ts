import { describe, expect, it } from "vitest";
import {
  CONNECTION_STATES,
  STATUS_KINDS,
  STATUS_URGENCY,
  compareStatusUrgency,
  connectionMeta,
  isConnectionState,
  isStatusKind,
  statusMeta,
  toConnectionState,
  toStatusKind,
  type StatusKind,
} from "@/ui/status";

describe("statusMeta", () => {
  it("covers every kind", () => {
    for (const kind of STATUS_KINDS) {
      const meta = statusMeta(kind);
      expect(meta.kind).toBe(kind);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it("gives every kind its own glyph, so colour is never the only signal", () => {
    const icons = STATUS_KINDS.map((kind) => statusMeta(kind).icon);
    expect(new Set(icons).size).toBe(STATUS_KINDS.length);
  });

  it("gives every kind its own label and its own colour tokens", () => {
    const labels = STATUS_KINDS.map((kind) => statusMeta(kind).label);
    expect(new Set(labels).size).toBe(STATUS_KINDS.length);
    // `unknown` and `stale` deliberately differ: "no data" is not "old data".
    expect(statusMeta("unknown").fg).not.toBe(statusMeta("stale").fg);
  });
});

describe("isStatusKind / toStatusKind", () => {
  it("accepts the known kinds", () => {
    for (const kind of STATUS_KINDS) {
      expect(isStatusKind(kind)).toBe(true);
      expect(toStatusKind(kind)).toBe(kind);
    }
  });

  it("rejects anything else without throwing", () => {
    for (const value of ["OK", "done", "", null, undefined, 0, {}, ["ok"]]) {
      expect(isStatusKind(value)).toBe(false);
      expect(toStatusKind(value)).toBe("unknown");
    }
  });
});

describe("urgency order", () => {
  it("lists every kind exactly once", () => {
    expect([...STATUS_URGENCY].sort()).toEqual([...STATUS_KINDS].sort());
  });

  it("sorts overdue first and ok last", () => {
    const shuffled: StatusKind[] = ["ok", "unknown", "due", "overdue", "stale", "blocked"];
    expect([...shuffled].sort(compareStatusUrgency)).toEqual([
      "overdue",
      "due",
      "blocked",
      "stale",
      "unknown",
      "ok",
    ]);
  });

  it("ranks unknown above ok: missing data is something to look at", () => {
    expect(compareStatusUrgency("unknown", "ok")).toBeLessThan(0);
  });

  it("is a stable comparator for equal kinds", () => {
    expect(compareStatusUrgency("due", "due")).toBe(0);
  });
});

describe("connection state", () => {
  it("maps every state to a status colour and a label", () => {
    for (const state of CONNECTION_STATES) {
      const meta = connectionMeta(state);
      expect(meta.state).toBe(state);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(isStatusKind(meta.kind)).toBe(true);
    }
  });

  it("never shows an unknown link as working", () => {
    expect(connectionMeta("unknown").kind).toBe("unknown");
    expect(connectionMeta("disconnected").kind).not.toBe("ok");
    expect(connectionMeta("degraded").kind).not.toBe("ok");
    expect(connectionMeta("connected").kind).toBe("ok");
  });

  it("narrows untrusted input, defaulting to unknown", () => {
    expect(isConnectionState("connected")).toBe(true);
    expect(isConnectionState("offline")).toBe(false);
    expect(toConnectionState("degraded")).toBe("degraded");
    expect(toConnectionState(null)).toBe("unknown");
    expect(toConnectionState("anything")).toBe("unknown");
  });
});
