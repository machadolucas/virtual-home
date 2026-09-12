import "server-only";
import { z } from "zod";
import { asc, desc, eq, isNull } from "drizzle-orm";
import { writeTx, type Db } from "@/db/client";
import { newId } from "@/db/ids";
import { maintenancePlan, serviceProvider } from "@/db/schema";
import { NotFoundError } from "@/domain/errors";
import { writeAuditLog, type DomainCtx } from "@/domain/occurrence";

const optionalText = (max: number) => z.string().trim().max(max).nullish();
export const providerInput = z.object({
  name: z.string().trim().min(1).max(200),
  trade: optionalText(80), contactName: optionalText(200), phone: optionalText(80),
  email: z.union([z.email(), z.literal("")]).nullish(),
  website: z.union([z.url().refine((value) => /^https?:\/\//i.test(value), "Use an http or https website"), z.literal("")]).nullish(),
  address: optionalText(500), vatId: optionalText(80), notes: optionalText(4000),
  isPreferred: z.boolean().optional(),
});
export type ProviderInput = z.infer<typeof providerInput>;
export function listProviders(db: Db, includeArchived = false) {
  return db.select().from(serviceProvider).where(includeArchived ? undefined : isNull(serviceProvider.archivedAtMs))
    .orderBy(desc(serviceProvider.isPreferred), asc(serviceProvider.name), asc(serviceProvider.id)).all();
}
export function getProvider(db: Db, id: string) {
  const row = db.select().from(serviceProvider).where(eq(serviceProvider.id, id)).get();
  if (!row) throw new NotFoundError("service_provider", id);
  return row;
}
function values(raw: ProviderInput) {
  const input = providerInput.parse(raw);
  return { name: input.name, trade: input.trade || null, contactName: input.contactName || null,
    phone: input.phone || null, email: input.email || null, website: input.website || null,
    address: input.address || null, vatId: input.vatId || null, notes: input.notes || null,
    isPreferred: input.isPreferred ?? false };
}
export function createProviderRecord(db: Db, ctx: DomainCtx, input: ProviderInput) {
  const fields = values(input);
  return writeTx(db, (tx) => {
    const id = newId(), now = ctx.clock.now();
    tx.insert(serviceProvider).values({ id, ...fields, createdAtMs: now, updatedAtMs: now, createdBy: ctx.actorUserId, updatedBy: ctx.actorUserId }).run();
    writeAuditLog(tx, ctx, { entityTable: "service_provider", entityId: id, action: "created", summary: `Added provider "${fields.name}"` });
    return { providerId: id };
  });
}
export function updateProviderRecord(db: Db, ctx: DomainCtx, id: string, input: ProviderInput) {
  const fields = values(input);
  return writeTx(db, (tx) => {
    getProvider(tx, id);
    tx.update(serviceProvider).set({ ...fields, updatedAtMs: ctx.clock.now(), updatedBy: ctx.actorUserId }).where(eq(serviceProvider.id, id)).run();
    writeAuditLog(tx, ctx, { entityTable: "service_provider", entityId: id, action: "updated", summary: `Updated provider "${fields.name}"` });
    return { providerId: id };
  });
}
export function archiveProviderRecord(db: Db, ctx: DomainCtx, id: string, archived: boolean) {
  return writeTx(db, (tx) => {
    const row = getProvider(tx, id), now = ctx.clock.now();
    tx.update(serviceProvider).set({ archivedAtMs: archived ? now : null, updatedAtMs: now, updatedBy: ctx.actorUserId }).where(eq(serviceProvider.id, id)).run();
    if (archived) tx.update(maintenancePlan).set({ defaultProviderId: null, updatedAtMs: now, updatedBy: ctx.actorUserId }).where(eq(maintenancePlan.defaultProviderId, id)).run();
    writeAuditLog(tx, ctx, { entityTable: "service_provider", entityId: id, action: archived ? "archived" : "restored", summary: `${archived ? "Archived" : "Restored"} provider "${row.name}"${archived ? "; cleared plan defaults, preserved bookings and history" : ""}` });
    return { providerId: id };
  });
}
