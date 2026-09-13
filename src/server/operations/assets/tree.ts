import "server-only";
import { z } from "zod";
import { and,eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { ASSET_CATEGORIES } from "@/db/schema/assets";
import { asset,assetPlacement } from "@/db/schema";
import { HttpError } from "@/server/api/handler";
import { writeAudit } from "@/domain/inventory";
import { userContext } from "@/server/queries/settings/household";

export const newTreeInput=z.object({name:z.string().trim().min(1).max(200),notes:z.string().trim().max(10000).nullable()}).strict();
export const newEquipmentInput=newTreeInput.extend({category:z.enum(ASSET_CATEGORIES)});

/** Called within the placement writeTx after geometry validation. Cancellation never calls this. */
export function createPlacedEquipmentRecord(tx:Db,userId:string,id:string,placementId:string,raw:unknown,locationId:string|null,symbol:string|null){
  z.uuid().parse(id);z.uuid().parse(placementId);const input=newEquipmentInput.parse(raw);
  const existing=tx.select().from(asset).where(eq(asset.id,id)).get();
  if(existing){
    const placed=tx.select().from(assetPlacement).where(and(eq(assetPlacement.id,placementId),eq(assetPlacement.assetId,id))).get();
    if(existing.name!==input.name||existing.notes!==input.notes||existing.category!==input.category||placed?.symbol!==symbol)throw new HttpError(409,"equipment_request_conflict");
    return;
  }
  const now=Date.now();
  tx.insert(asset).values({id,name:input.name,notes:input.notes,category:input.category,status:"installed",isVirtual:false,locationId,createdAtMs:now,updatedAtMs:now,createdBy:userId,updatedBy:userId}).run();
  writeAudit(tx,userContext({user:{id:userId}},tx),{entityTable:"asset",entityId:id,action:"create",summary:`Created “${input.name}” with its model placement`});
}
