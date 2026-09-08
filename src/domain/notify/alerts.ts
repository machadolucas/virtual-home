/**
 * `app_alert` writes, with the de-duplication the partial unique index expects: re-raising an
 * unresolved alert bumps `last_seen_at_ms`/`seen_count` instead of creating noise.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import { appAlert, type AppAlertKind, type AppAlertSeverity } from "@/db/schema/inventory";
import type { DomainCtx } from "../occurrence";

export interface RaiseAlertInput {
  kind: AppAlertKind;
  severity: AppAlertSeverity;
  title: string;
  body?: string;
  dedupeKey: string;
  entityTable?: string;
  entityId?: string;
}

/** Raise (or re-observe) an in-app alert. Returns the alert id. */
export function raiseAppAlert(tx: Db, ctx: DomainCtx, input: RaiseAlertInput): string {
  const now = ctx.clock.now();
  const existing = tx
    .select()
    .from(appAlert)
    .where(and(eq(appAlert.dedupeKey, input.dedupeKey), isNull(appAlert.resolvedAtMs)))
    .all()[0];
  if (existing) {
    tx.update(appAlert)
      .set({ lastSeenAtMs: now, seenCount: sql`${appAlert.seenCount} + 1` })
      .where(eq(appAlert.id, existing.id))
      .run();
    return existing.id;
  }
  const id = newId();
  tx.insert(appAlert)
    .values({
      id,
      kind: input.kind,
      severity: input.severity,
      entityTable: input.entityTable ?? null,
      entityId: input.entityId ?? null,
      title: input.title,
      body: input.body ?? null,
      dedupeKey: input.dedupeKey,
      firstSeenAtMs: now,
      lastSeenAtMs: now,
      seenCount: 1,
    })
    .run();
  return id;
}
