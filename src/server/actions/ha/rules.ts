"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { conditionEpisode, conditionRule } from "@/db/schema";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import {
  deleteConditionRuleInput,
  setConditionRuleEnabledInput,
  upsertConditionRuleInput,
} from "./schemas";

/**
 * Condition rules — the things that turn Home Assistant readings into maintenance work.
 *
 * Two properties the form has to preserve, both from §6.3:
 *  - **Hysteresis is not optional.** A rule with no clear level and no sustain would open a task
 *    the first time a battery dips to 14 % and close it the next reading. The schema allows nulls
 *    (they fall back to `household_setting`), and the UI says so rather than pretending the fields
 *    are blank because nothing applies.
 *  - **A rule never fabricates history.** Disabling one closes its open episodes with
 *    `rule_disabled`; the *occurrence* it opened stays open, because a task nobody did is still a
 *    task (§6.5).
 */

export const upsertConditionRule = action(upsertConditionRuleInput, async (input, session) => {
  const { db } = getDb();
  const ruleId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const at = nowMs();
      const values = {
        kind: input.kind,
        name: input.name,
        scope: input.scope,
        assetId: input.scope === "asset" ? (input.assetId ?? null) : (input.assetId ?? null),
        haEntityRegistryId: input.haEntityRegistryId ?? null,
        thresholdPct: input.thresholdPct ?? null,
        clearThresholdPct: input.clearThresholdPct ?? null,
        sustainMinutes: input.sustainMinutes ?? null,
        clearSustainMinutes: input.clearSustainMinutes ?? null,
        defaultPartId: input.defaultPartId ?? null,
        priority: input.priority,
        // Shared, always: this household has no notion of "your rule".
        assignmentMode: "shared" as const,
        assigneeUserId: null,
        titleTemplate: input.titleTemplate,
        enabled: input.enabled,
        updatedAtMs: at,
        updatedBy: ctx.actorUserId,
      };

      let id = input.ruleId ?? null;
      if (id === null) {
        id = newId();
        tx.insert(conditionRule)
          .values({ id, ...values, createdAtMs: at, createdBy: ctx.actorUserId })
          .run();
      } else {
        const before = tx.select().from(conditionRule).where(eq(conditionRule.id, id)).get();
        if (!before) throw new NotFoundError("condition_rule", id);
        tx.update(conditionRule).set(values).where(eq(conditionRule.id, id)).run();
        if (before.enabled && !input.enabled) closeOpenEpisodes(tx, ctx, id, at);
      }

      writeAudit(tx, ctx, {
        entityTable: "condition_rule",
        entityId: id,
        action: input.ruleId === null ? "created" : "updated",
        summary: `${input.kind} rule “${input.name}” (${input.scope})`,
      });
      return id;
    }),
  );
  revalidatePath("/settings/home-assistant");
  revalidatePath("/equipment");
  return { ruleId };
});

export const setConditionRuleEnabled = action(
  setConditionRuleEnabledInput,
  async (input, session) => {
    const { db } = getDb();
    mapDomainErrors(() =>
      writeTx(db, (tx) => {
        const ctx = userContext(session, tx);
        const at = nowMs();
        const before = tx
          .select()
          .from(conditionRule)
          .where(eq(conditionRule.id, input.ruleId))
          .get();
        if (!before) throw new NotFoundError("condition_rule", input.ruleId);
        tx.update(conditionRule)
          .set({ enabled: input.enabled, updatedAtMs: at, updatedBy: ctx.actorUserId })
          .where(eq(conditionRule.id, input.ruleId))
          .run();
        if (before.enabled && !input.enabled) closeOpenEpisodes(tx, ctx, input.ruleId, at);
        writeAudit(tx, ctx, {
          entityTable: "condition_rule",
          entityId: input.ruleId,
          action: "updated",
          summary: `rule “${before.name}” ${input.enabled ? "enabled" : "disabled"}`,
          changes: { enabled: [before.enabled, input.enabled] },
        });
      }),
    );
    revalidatePath("/settings/home-assistant");
    return { ok: true as const };
  },
);

export const deleteConditionRule = action(deleteConditionRuleInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const before = tx
        .select()
        .from(conditionRule)
        .where(eq(conditionRule.id, input.ruleId))
        .get();
      if (!before) throw new NotFoundError("condition_rule", input.ruleId);
      // `maintenance_occurrence.condition_rule_id` is ON DELETE RESTRICT, so a rule that has ever
      // produced a task cannot be deleted. Disabling it is the honest alternative: the tasks it
      // produced were real.
      const at = nowMs();
      closeOpenEpisodes(tx, ctx, input.ruleId, at);
      try {
        tx.delete(conditionRule).where(eq(conditionRule.id, input.ruleId)).run();
      } catch {
        throw new ValidationError(
          "rule_has_history",
          "this rule has already produced tasks, so it cannot be deleted — disable it instead",
          { ruleId: input.ruleId },
        );
      }
      writeAudit(tx, ctx, {
        entityTable: "condition_rule",
        entityId: input.ruleId,
        action: "deleted",
        summary: `rule “${before.name}” deleted`,
      });
    }),
  );
  revalidatePath("/settings/home-assistant");
  return { ok: true as const };
});

/**
 * Close this rule's open episodes with `rule_disabled`.
 *
 * The occurrences those episodes opened are left alone on purpose (§6.5): switching a rule off
 * stops watching, it does not assert that anybody replaced a battery.
 */
function closeOpenEpisodes(
  tx: Parameters<Parameters<typeof writeTx>[1]>[0],
  ctx: ReturnType<typeof userContext>,
  ruleId: string,
  atMs: number,
): void {
  const open = tx
    .select()
    .from(conditionEpisode)
    .where(eq(conditionEpisode.ruleId, ruleId))
    .all()
    .filter((row) => row.closedAtMs === null);
  for (const episode of open) {
    tx.update(conditionEpisode)
      .set({ closedAtMs: atMs, closeReason: "rule_disabled" })
      .where(eq(conditionEpisode.id, episode.id))
      .run();
    writeAudit(tx, ctx, {
      entityTable: "condition_episode",
      entityId: episode.id,
      action: "closed",
      summary: "episode closed because its rule was switched off; any task it opened stays open",
    });
  }
}
