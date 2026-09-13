import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth/auth";

const handler = toNextJsHandler((request: Request) => {
  // Household ownership never grants Better Auth's generic admin/impersonation API.
  if (decodeURIComponent(new URL(request.url).pathname).startsWith("/api/auth/admin/")) return Promise.resolve(new Response(null, { status: 404 }));
  return getAuth().handler(request);
});
export const { GET, POST } = handler;
