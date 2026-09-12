"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getDb, writeTx } from "@/db/client";
import { mcpConnection } from "@/db/schema/mcp";
import { writeAudit } from "@/domain/inventory";
import { freshAction } from "@/server/api/action";
import { HttpError } from "@/server/api/handler";
import { userContext } from "@/server/queries/settings/household";
import { connectionInput, createConnection, rotateConnectionToken } from "@/server/mcp/auth";
import { decideRequest } from "@/server/mcp/mutations";
import { publish, EVENT_TOPICS } from "@/server/events/outbox";

export const addConnection=freshAction(connectionInput,(input,session)=>{
  const result=writeTx(getDb().db,tx=>{
    const created=createConnection(tx,session.user.id,input);
    writeAudit(tx,userContext(session,tx),{entityTable:"mcp_connection",entityId:created.id,action:"created",summary:`AI connection ${input.name} created`});
    return created;
  });
  revalidatePath("/settings/ai-connections");return result;
});

export const revokeConnection=freshAction(z.object({id:z.uuid()}),(input,session)=>{
  writeTx(getDb().db,tx=>{
    const row=tx.select().from(mcpConnection).where(eq(mcpConnection.id,input.id)).get();
    if(!row)throw new HttpError(404,"not_found");
    tx.update(mcpConnection).set({revokedAtMs:Date.now()}).where(eq(mcpConnection.id,row.id)).run();
    writeAudit(tx,userContext(session,tx),{entityTable:"mcp_connection",entityId:row.id,action:"revoked",summary:`AI connection ${row.name} revoked`});
    publish(tx,[{topic:EVENT_TOPICS.alertChanged,entityKey:`mcp:${row.id}`,payload:{connectionId:row.id,status:"revoked"}}]);
  });
  revalidatePath("/settings/ai-connections");return {id:input.id};
});

export const reviewRequest=freshAction(z.object({id:z.uuid(),decision:z.enum(["approve","reject"])}),(input,session)=>{
  const result=decideRequest(input.id,session.user.id,input.decision);
  for(const path of result.paths)revalidatePath(path);
  revalidatePath("/settings/ai-connections");return result.data;
});

export const rotateConnection=freshAction(z.object({id:z.uuid()}),(input,session)=>{
  const result=writeTx(getDb().db,tx=>{
    const rotated=rotateConnectionToken(tx,input.id);
    writeAudit(tx,userContext(session,tx),{entityTable:"mcp_connection",entityId:input.id,action:"rotated",summary:"AI connection token rotated"});
    return rotated;
  });
  revalidatePath("/settings/ai-connections");return result;
});
