"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { archiveProviderRecord, createProviderRecord, providerInput, updateProviderRecord } from "@/server/services/providers";
import { domainCall, id, idempotencyKey, revalidateMaintenance } from "./shared";
function refresh(providerId: string) { revalidatePath("/providers"); revalidatePath(`/providers/${providerId}`); revalidateMaintenance(); }
export const createProvider = action(providerInput.extend({ idempotencyKey: idempotencyKey.optional() }), (input, session) => {
  const { db, ctx } = maintenanceContext(session.user.id);
  const result = domainCall("create_provider", () => createProviderRecord(db, ctx, input));
  refresh(result.providerId); return result;
});
export const updateProvider = action(providerInput.extend({ providerId: id, idempotencyKey: idempotencyKey.optional() }), (input, session) => {
  const { db, ctx } = maintenanceContext(session.user.id);
  const result = domainCall("update_provider", () => updateProviderRecord(db, ctx, input.providerId, input));
  refresh(result.providerId); return result;
});
export const archiveProvider = action(z.object({ providerId: id, archived: z.boolean(), idempotencyKey: idempotencyKey.optional() }), (input, session) => {
  const { db, ctx } = maintenanceContext(session.user.id);
  const result = domainCall("archive_provider", () => archiveProviderRecord(db, ctx, input.providerId, input.archived));
  refresh(result.providerId); return result;
});
