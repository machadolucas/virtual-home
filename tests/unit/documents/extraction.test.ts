import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { loadEnv } from "@/env";
import { extractPdf } from "@/server/documents/text";
import { syntheticPdf } from "../../helpers/pdf";
const relative = "synthetic-extraction.pdf";
const root = loadEnv().attachDir;
beforeAll(async()=>{await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,relative),syntheticPdf());});
afterAll(async()=>{await fs.rm(path.join(root,relative),{force:true});});
it("extracts page references from a real PDF without interpreting maintenance as completion",async()=>{
  const result=await extractPdf({id:"test-pdf",kind:"pdf",mime:"application/pdf",byteSize:100,sha256:"synthetic",storagePath:relative,originalFilename:"test.pdf",caption:null,width:null,height:null,hasWebCopy:false,takenAtMs:null,createdAtMs:1,updatedAtMs:1,createdBy:null,updatedBy:null});
  expect(result.status).toBe("ready");expect(result.pages).toHaveLength(2);expect(result.pages[0]).toMatchObject({page:1,text:expect.stringContaining("Synthetic equipment manual")});expect(result.pages[1]).toMatchObject({page:2,text:expect.stringContaining("Maintenance instructions")});
});
