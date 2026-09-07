import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth/auth";

const handler = toNextJsHandler(() => getAuth().handler);
export const { GET, POST } = handler;
