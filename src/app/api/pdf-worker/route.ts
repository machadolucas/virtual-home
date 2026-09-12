import fs from "node:fs/promises";
import path from "node:path";
import { authed } from "@/server/api/handler";
export const runtime = "nodejs";
/** Read installed worker bytes. require.resolve is transformed to a module ID by Turbopack. */
export const GET = authed(async () => {
  const bytes = await fs.readFile(path.join(process.cwd(), "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"));
  return new Response(bytes, { headers: { "Content-Type": "text/javascript", "Cache-Control": "private, max-age=3600" } });
});
