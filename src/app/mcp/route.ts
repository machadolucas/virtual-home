import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDb } from "@/db/client";
import { loadEnv } from "@/env";
import { HttpError, jsonError } from "@/server/api/handler";
import { authenticateMcp } from "@/server/mcp/auth";
import { createMcpServer } from "@/server/mcp/server";
import { log } from "@/server/log";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const MAX_BODY_BYTES=128*1024;

/** MCP is the explicit token-authenticated exception to browser-cookie authorization. */
async function handle(request:Request):Promise<Response> {
  try {
    const identity=authenticateMcp(getDb().db,request.headers.get("authorization"));
    const base=new URL(loadEnv().VH_BASE_URL);
    if(request.headers.get("host")!==base.host) throw new HttpError(403,"invalid_host");
    const origin=request.headers.get("origin");
    if(origin!==null&&origin!==base.origin) throw new HttpError(403,"invalid_origin");
    if(request.method!=="POST") return new Response(null,{status:405,headers:{Allow:"POST, PUT","Cache-Control":"private, no-store"}});
    if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415,"json_required");
    const advertised=Number(request.headers.get("content-length")??0);
    if(advertised>MAX_BODY_BYTES) throw new HttpError(413,"request_too_large");
    const reader=request.body?.getReader(); if(!reader) throw new HttpError(400,"body_required");
    let size=0;const chunks:Uint8Array[]=[];
    for(;;) {const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
      if(size>MAX_BODY_BYTES){await reader.cancel();throw new HttpError(413,"request_too_large");}chunks.push(next.value);}
    let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new HttpError(400,"invalid_json");}
    const transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true});
    const server=createMcpServer(identity);
    await server.connect(transport);
    try {
      const response=await transport.handleRequest(request,{parsedBody:body});
      // Buffer the bounded JSON response before closing this stateless request transport.
      const bytes=await response.arrayBuffer();
      const headers=new Headers(response.headers);headers.set("Cache-Control","private, no-store");headers.set("Vary","Authorization");
      return new Response(bytes,{status:response.status,headers});
    } finally {await server.close();}
  } catch(err) {
    if(err instanceof HttpError) {
      const response=jsonError(err.status,err.code,err.details);
      if(err.status===401) response.headers.set("WWW-Authenticate",'Bearer realm="virtual-home"');
      return response;
    }
    log.error({err},"MCP request failed");return jsonError(500,"internal");
  }
}
export const POST=handle;
export const GET=handle;
export const DELETE=handle;
export const OPTIONS=handle;
export {handleUpload as PUT} from "@/server/mcp/upload";
