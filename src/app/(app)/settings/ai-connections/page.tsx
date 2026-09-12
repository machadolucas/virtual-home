import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpConnection, mcpRequest } from "@/db/schema/mcp";
import { user } from "@/db/schema/auth";
import { getFreshSession, requireSessionPage } from "@/server/auth/session";
import { loadEnv } from "@/env";
import { nowMs } from "@/db/ids";
import { PageHeader } from "@/ui/shell";
import { AiConnections } from "./AiConnections";

export const metadata:Metadata={title:"AI connections"};
export default async function AiConnectionsPage(){
  await requireSessionPage("/settings/ai-connections");
  const session=await getFreshSession();
  if(!session)redirect("/login?next=%2Fsettings%2Fai-connections");
  const {db}=getDb();
  const connections=db.select({id:mcpConnection.id,name:mcpConnection.name,userName:user.name,tokenPrefix:mcpConnection.tokenPrefix,
    scopesJson:mcpConnection.scopesJson,expiresAtMs:mcpConnection.expiresAtMs,revokedAtMs:mcpConnection.revokedAtMs,lastUsedAtMs:mcpConnection.lastUsedAtMs})
    .from(mcpConnection).innerJoin(user,eq(user.id,mcpConnection.userId)).orderBy(desc(mcpConnection.createdAtMs)).limit(100).all();
  const requests=db.select({id:mcpRequest.id,operation:mcpRequest.operation,payloadJson:mcpRequest.payloadJson,summary:mcpRequest.summary,
    state:mcpRequest.state,expiresAtMs:mcpRequest.expiresAtMs,createdAtMs:mcpRequest.createdAtMs,resultJson:mcpRequest.resultJson,
    connectionName:mcpConnection.name,revokedAtMs:mcpConnection.revokedAtMs}).from(mcpRequest).innerJoin(mcpConnection,eq(mcpConnection.id,mcpRequest.connectionId))
    .orderBy(desc(mcpRequest.createdAtMs)).limit(100).all();
  return <><PageHeader eyebrow="Settings" title="AI connections" description="Connect your local AI apps to household records. Choose what each connection can do and review actions that change stock, history or equipment."/>
    <AiConnections connections={connections} requests={requests} endpoint={`${loadEnv().VH_BASE_URL.replace(/\/$/,"")}/mcp`} now={nowMs()}/></>;
}
