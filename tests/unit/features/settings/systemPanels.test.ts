/**
 * `/settings/system` and `/settings/model` read honestly.
 *
 * The page's own promise is "nothing here is a reassuring tick it cannot justify", and these are
 * the three places it was breaking it:
 *  - "Last backup … Succeeded" was the newest *successful* run, so a green outcome could sit
 *    directly above three newer failed ones;
 *  - "Failed or given up: N" counted `failed + abandoned` but listed only `failed`, and nothing in
 *    the codebase ever writes `failed` on `ha_notify_command` — so the count stood above a list
 *    that was permanently empty;
 *  - "No reconciliation is open" was derived from the five most recently *created* plans, so six
 *    imports after a plan opened, the page confidently denied it existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `src/server/queries/**` carries the `server-only` guard, which throws outside a server
// component. The same stub the other query tests use.
vi.mock("server-only", () => ({}));

import { writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import {
  backupRun,
  haNotifyCommand,
  modelReconciliation,
  modelRevision,
} from "@/db/schema";
import { readSystemHealth } from "@/server/queries/settings/system";
import { listReconciliations } from "@/server/queries/settings/model";
import { testDb } from "../../../helpers/db";

const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;

let handle: DbHandle;

beforeEach(() => {
  handle = testDb();
});

afterEach(() => {
  handle.close();
});

function seedBackup(input: { atMs: number; ok: boolean; label: string }): string {
  const id = newId();
  writeTx(handle.db, (tx) => {
    tx.insert(backupRun)
      .values({
        id,
        createdAtMs: input.atMs,
        label: input.label,
        path: `/backups/${input.label}`,
        bytes: 1024,
        ok: input.ok,
        error: input.ok ? null : "rsync exited 23",
      })
      .run();
  });
  return id;
}

function seedNotifyCommand(input: {
  state: "queued" | "sent" | "failed" | "abandoned";
  atMs: number;
}): string {
  const id = newId();
  writeTx(handle.db, (tx) => {
    tx.insert(haNotifyCommand)
      .values({
        id,
        kind: "notify",
        notifyService: "notify.mobile_app_test",
        payloadJson: "{}",
        tag: `tag-${id}`,
        dedupeKey: `dedupe-${id}`,
        state: input.state,
        attemptCount: 3,
        lastError: "Service notify.mobile_app_test not found",
        createdAtMs: input.atMs,
      })
      .run();
  });
  return id;
}

describe("readSystemHealth — backups", () => {
  it("reports the newest run even when it failed, and the last success separately", () => {
    const succeeded = seedBackup({ atMs: T0 - 4 * HOUR, ok: true, label: "daily-old" });
    seedBackup({ atMs: T0 - 3 * HOUR, ok: false, label: "daily-1" });
    seedBackup({ atMs: T0 - 2 * HOUR, ok: false, label: "daily-2" });
    const newest = seedBackup({ atMs: T0 - HOUR, ok: false, label: "daily-3" });

    const health = readSystemHealth(handle.db, T0);

    // The headline is the most recent attempt, outcome included — never the most recent one that
    // happened to work.
    expect(health.lastBackup?.id).toBe(newest);
    expect(health.lastBackup?.ok).toBe(false);
    expect(health.lastSuccessfulBackup?.id).toBe(succeeded);
  });

  it("finds a success older than the five rows the recent list shows", () => {
    const succeeded = seedBackup({ atMs: T0 - 100 * HOUR, ok: true, label: "weekly" });
    for (let i = 0; i < 6; i += 1) {
      seedBackup({ atMs: T0 - i * HOUR, ok: false, label: `daily-${i}` });
    }

    const health = readSystemHealth(handle.db, T0);

    expect(health.recentBackups).toHaveLength(5);
    expect(health.recentBackups.some((row) => row.id === succeeded)).toBe(false);
    // The list is capped; the figure is not, or "no successful backup" would be a lie about the cap.
    expect(health.lastSuccessfulBackup?.id).toBe(succeeded);
  });

  it("says there is no successful backup when every recorded run failed", () => {
    seedBackup({ atMs: T0 - HOUR, ok: false, label: "daily-1" });
    const health = readSystemHealth(handle.db, T0);
    expect(health.lastBackup).not.toBeNull();
    expect(health.lastSuccessfulBackup).toBeNull();
  });
});

describe("readSystemHealth — notifications", () => {
  it("lists the abandoned commands the headline count includes", () => {
    const abandoned = seedNotifyCommand({ state: "abandoned", atMs: T0 - HOUR });
    seedNotifyCommand({ state: "sent", atMs: T0 - 2 * HOUR });
    seedNotifyCommand({ state: "queued", atMs: T0 - 3 * HOUR });

    const health = readSystemHealth(handle.db, T0);

    const headline =
      health.notifyStateCounts.failed + health.notifyStateCounts.abandoned;
    expect(headline).toBe(1);
    // The bug: the count included `abandoned`, the list queried `failed` only, and nothing writes
    // `failed` on this table — so the count always stood over an empty list.
    expect(health.notifyFailures.map((row) => row.id)).toEqual([abandoned]);
    expect(health.notifyFailures[0]?.state).toBe("abandoned");
  });

  it("never lists a command that has not ended badly", () => {
    seedNotifyCommand({ state: "sent", atMs: T0 - HOUR });
    seedNotifyCommand({ state: "queued", atMs: T0 - 2 * HOUR });

    const health = readSystemHealth(handle.db, T0);
    expect(health.notifyFailures).toHaveLength(0);
  });
});

describe("readSystemHealth — storage", () => {
  it("separates a file that is absent from one it could not measure", () => {
    const storage = readSystemHealth(handle.db, T0).storage;
    // The test database is in memory, so neither file exists. What matters is that "absent" is a
    // distinct answer from "unreadable" rather than one shared `null` rendered as "None".
    expect(["absent", "unreadable", "bytes"]).toContain(storage.dbBytes.kind);
    expect(storage.walBytes.kind).toBe("absent");
  });
});

describe("listReconciliations", () => {
  function seedRevision(hash: string): string {
    const id = newId();
    writeTx(handle.db, (tx) => {
      tx.insert(modelRevision)
        .values({
          id,
          modelId: "test-model",
          schemaVersion: "1.0",
          contentHash: hash,
          status: "superseded",
          coordinateSystemJson: "{}",
          nodeCount: 0,
          generatedAtMs: T0,
          importedAtMs: T0,
        })
        .run();
    });
    return id;
  }

  function seedPlan(input: {
    status: "open" | "applied" | "abandoned";
    createdAtMs: number;
    from: string;
    to: string;
  }): string {
    const id = newId();
    writeTx(handle.db, (tx) => {
      tx.insert(modelReconciliation)
        .values({
          id,
          fromRevisionId: input.from,
          toRevisionId: input.to,
          status: input.status,
          createdAtMs: input.createdAtMs,
          createdBy: null,
        })
        .run();
    });
    return id;
  }

  it("returns an open plan buried under newer settled ones", () => {
    const from = seedRevision("a".repeat(64));
    const to = seedRevision("b".repeat(64));
    const open = seedPlan({ status: "open", createdAtMs: T0 - 100 * HOUR, from, to });
    for (let i = 0; i < 6; i += 1) {
      seedPlan({ status: "applied", createdAtMs: T0 - i * HOUR, from, to });
    }

    const plans = listReconciliations(handle.db);

    // The panel's "No reconciliation is open" is `plans.filter(status === 'open')`, so a query that
    // takes the five newest by creation date and filters afterwards turns a waiting decision into
    // a confident denial.
    expect(plans.filter((plan) => plan.status === "open").map((plan) => plan.id)).toEqual([open]);
  });

  it("still caps the settled plans it lists", () => {
    const from = seedRevision("c".repeat(64));
    const to = seedRevision("d".repeat(64));
    for (let i = 0; i < 8; i += 1) {
      seedPlan({ status: "applied", createdAtMs: T0 - i * HOUR, from, to });
    }

    const plans = listReconciliations(handle.db);
    expect(plans).toHaveLength(5);
  });
});
