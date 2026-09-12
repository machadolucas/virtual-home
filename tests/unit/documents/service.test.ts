import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { eq } from "drizzle-orm";
import { writeTx, type DbHandle } from "@/db/client";
import { asset, attachment, attachmentLink, serviceDocument } from "@/db/schema";
import { documentText } from "@/db/schema/documentText";
import { documentMetadataInput, linkDocument, saveServiceDocument, updateDocumentMetadata } from "@/server/documents/service";
import { EXTRACTOR_VERSION, readDocumentText } from "@/server/documents/text";
import { searchRecords } from "@/server/queries/search";
import { seedUser, testDb } from "../../helpers/db";
let handle: DbHandle; let actor: string;
beforeEach(() => {
  handle = testDb(); actor = seedUser(handle,{username:"reader",name:"Reader"}).id;
  writeTx(handle.db, db => {
    db.insert(attachment).values({id:"manual",kind:"pdf",mime:"application/pdf",byteSize:100,sha256:"abc",storagePath:"2026/01/manual.pdf",originalFilename:"Manual.pdf",caption:"Old title",createdAtMs:1,updatedAtMs:1}).run();
    db.insert(asset).values({id:"unit",name:"Synthetic equipment",category:"appliance",status:"planned",createdAtMs:1,updatedAtMs:1}).run();
  });
});
afterEach(() => handle.close());
describe("document authoring", () => {
  it("patches only supplied fields and rejects stale changes", () => {
    const updated = writeTx(handle.db, db => updateDocumentMetadata(db,actor,{id:"manual",expectedUpdatedAtMs:1,caption:null}));
    const row = handle.db.select().from(attachment).where(eq(attachment.id,"manual")).get()!;
    expect(row.caption).toBeNull(); expect(row.originalFilename).toBe("Manual.pdf"); expect(updated.updatedAtMs).toBeGreaterThan(1);
    expect(() => writeTx(handle.db,db => updateDocumentMetadata(db,actor,{id:"manual",expectedUpdatedAtMs:1,caption:"Lost edit"}))).toThrow();
    expect(documentMetadataInput.safeParse({id:"manual",expectedUpdatedAtMs:1,originalFilename:""}).success).toBe(false);
  });
  it("validates link targets and deduplicates repeated linking", () => {
    const input = {attachmentId:"manual",entityKind:"asset" as const,entityId:"unit"};
    const first = writeTx(handle.db,db=>linkDocument(db,actor,input));
    const second = writeTx(handle.db,db=>linkDocument(db,actor,input));
    expect(second).toEqual(first); expect(handle.db.select().from(attachmentLink).all()).toHaveLength(1);
    expect(() => writeTx(handle.db,db=>linkDocument(db,actor,{...input,entityId:"missing"}))).toThrow();
  });
  it("requires a real service association and never creates completion", () => {
    const input = {kind:"invoice" as const,attachmentId:"manual",providerId:null,assetId:null,bookingId:null,completionId:null};
    expect(()=>writeTx(handle.db,db=>saveServiceDocument(db,actor,input))).toThrow();
    const result = writeTx(handle.db,db=>saveServiceDocument(db,actor,{...input,assetId:"unit"}));
    expect(handle.db.select().from(serviceDocument).where(eq(serviceDocument.id,result.id)).get()?.attachmentId).toBe("manual");
  });
});
describe("bounded document text", () => {
  it("reports pending extraction and prevents reads of unknown records", () => {
    expect(readDocumentText(handle.db,"manual").status).toBe("pending");
    expect(()=>readDocumentText(handle.db,"missing")).toThrow();
  });
  it("indexes document titles and treats LIKE metacharacters literally", () => {
    expect(searchRecords(handle.db,"Manual",{kind:"documents"}).flatMap(g=>g.hits).some(h=>h.id==="manual")).toBe(true);
    expect(searchRecords(handle.db,"%_",{kind:"documents"}).flatMap(g=>g.hits)).toHaveLength(0);
  });
  it("returns a bounded page with continuations and invalidates changed hashes", () => {
    writeTx(handle.db,db=>db.insert(documentText).values({attachmentId:"manual",sha256:"abc",extractorVersion:EXTRACTOR_VERSION,status:"ready",pagesJson:JSON.stringify([{page:1,text:"abcdefghij"},{page:2,text:"second"}]),updatedAtMs:2}).run());
    expect(readDocumentText(handle.db,"manual",{maxChars:4})).toMatchObject({text:"abcd",nextOffset:4,nextPage:2});
    expect(readDocumentText(handle.db,"manual",{maxChars:4,offset:8})).toMatchObject({text:"ij",nextOffset:null});
    writeTx(handle.db,db=>db.update(attachment).set({sha256:"changed"}).where(eq(attachment.id,"manual")).run());
    expect(readDocumentText(handle.db,"manual").status).toBe("pending");
  });
});
