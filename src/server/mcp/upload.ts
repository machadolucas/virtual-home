import { Readable } from "node:stream";
import { z } from "zod";
import { getDb } from "@/db/client";
import { loadEnv } from "@/env";
import { authenticateMcp,assertConnection } from "@/server/mcp/auth";
import { storeUpload,UploadError } from "@/server/files/store";
import { SniffError } from "@/server/files/sniff";
import { ImageError } from "@/server/files/images";
import { HttpError,jsonError } from "@/server/api/handler";
import { log } from "@/server/log";
import { auditDocument } from "@/server/documents/service";


/** Binary upload keeps file bytes out of MCP tool schemas, JSON and model context. */
export async function handleUpload(request:Request){
  try{
    const identity=authenticateMcp(getDb().db,request.headers.get("authorization"));
    assertConnection(getDb().db,identity.connectionId,"author",Date.now(),identity.credentialHash);
    const env=loadEnv(),base=new URL(env.VH_BASE_URL),origin=request.headers.get("origin");
    if(request.headers.get("host")!==base.host||(origin!==null&&origin!==base.origin))throw new HttpError(403,"invalid_origin_or_host");
    if(!request.body)throw new HttpError(400,"file_body_required");
    if(Number(request.headers.get("content-length")??0)>env.VH_UPLOAD_MAX_BYTES)throw new HttpError(413,"upload_too_large");
    const originalName=z.string().min(1).max(240).parse(decodeURIComponent(request.headers.get("x-vh-filename")??""));
    const stored=await storeUpload({stream:Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]),origName:originalName,
      uploadedBy:identity.userId,maxBytes:env.VH_UPLOAD_MAX_BYTES,beforeCommit:tx=>{assertConnection(tx,identity.connectionId,"author",Date.now(),identity.credentialHash);},onRegistered:(tx,row)=>auditDocument(tx,identity.userId,"attachment",row.id,"uploaded")});
    const r=stored.row;
    return Response.json({id:r.id,kind:r.kind,mime:r.mime,byteSize:r.byteSize,originalFilename:r.originalFilename,updatedAtMs:r.updatedAtMs,
      deduped:stored.deduped,href:`/documents/${r.id}`,next:"Use documents_write with documents.link to link this document to equipment or a project."},
      {status:stored.deduped?200:201,headers:{"Cache-Control":"private, no-store",Vary:"Authorization"}});
  }catch(err){
    if(err instanceof HttpError)return jsonError(err.status,err.code,err.details);
    if(err instanceof UploadError)return jsonError(err.status,err.code);
    if(err instanceof SniffError)return jsonError(415,err.reason);
    if(err instanceof ImageError)return jsonError(415,err.code);
    if(err instanceof z.ZodError||err instanceof URIError)return jsonError(400,"invalid_filename");
    log.error({err},"MCP upload failed");return jsonError(500,"internal");
  }
}
