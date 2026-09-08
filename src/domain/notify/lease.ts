/**
 * Worker leases with a fence token (§4.3).
 *
 * Two workers may run (a stale launchd job, a developer's `pnpm worker:dev` against the same file).
 * The lease decides which one *schedules*; the fence token decides which one may *finalise*. A
 * loser whose claim has expired cannot write `sent`, because the finalising transaction re-reads
 * the lease and compares the fence it was claimed with.
 *
 * The caller supplies the transaction: `acquireLease` must be able to run as the first statement
 * of a tick's own `writeTx`.
 */
import { and, eq, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { workerLease } from "@/db/schema/notifications";

export const LEASE_NOTIFICATION_TICK = "notification_tick";
export const LEASE_HA_LISTENER = "ha_listener";
export const LEASE_OUTBOX_DRAIN = "outbox_drain";

/** TTL 90 s against a 60 s tick: one missed tick does not hand the lease away. */
export const DEFAULT_LEASE_TTL_MS = 90_000;

export type WorkerLeaseRow = typeof workerLease.$inferSelect;

export function readLease(tx: Db, name: string): WorkerLeaseRow | null {
  return tx.select().from(workerLease).where(eq(workerLease.name, name)).all()[0] ?? null;
}

/**
 * Acquire or renew `name` for `workerId`. Returns the fence token, or `null` when somebody else
 * holds a live lease.
 *
 * Renewing keeps the fence (the holder's claims stay valid); taking it over from an expired holder
 * bumps it, which invalidates every claim the previous holder made.
 */
export function acquireLease(
  tx: Db,
  name: string,
  workerId: string,
  ttlMs: number,
  now: number,
): number | null {
  tx.insert(workerLease)
    .values({ name, holderId: null, fence: 0, expiresAtMs: 0, updatedAtMs: now })
    .onConflictDoNothing()
    .run();

  const current = readLease(tx, name);
  const canTake =
    !current || current.holderId === null || current.expiresAtMs <= now || current.holderId === workerId;
  if (!canTake) return null;

  const fence = current && current.holderId === workerId ? current.fence : (current?.fence ?? 0) + 1;
  const result = tx
    .update(workerLease)
    .set({
      holderId: workerId,
      fence,
      acquiredAtMs: now,
      expiresAtMs: now + ttlMs,
      updatedAtMs: now,
    })
    .where(
      and(
        eq(workerLease.name, name),
        or(
          sql`${workerLease.holderId} IS NULL`,
          lte(workerLease.expiresAtMs, now),
          eq(workerLease.holderId, workerId),
        ),
      ),
    )
    .run();
  return result.changes === 1 ? fence : null;
}

/**
 * Is `workerId` still the holder at `fence`? Called inside the transaction that writes `sent`, so
 * a worker that lost the lease mid-flight cannot finalise.
 */
export function holdsLease(tx: Db, name: string, workerId: string, fence: number): boolean {
  const current = readLease(tx, name);
  return current?.holderId === workerId && current.fence === fence;
}

/** Hand the lease back immediately (clean shutdown), so the sibling can take over without waiting. */
export function releaseLease(tx: Db, name: string, workerId: string, now: number): void {
  tx.update(workerLease)
    .set({ holderId: null, expiresAtMs: 0, updatedAtMs: now })
    .where(and(eq(workerLease.name, name), eq(workerLease.holderId, workerId)))
    .run();
}
