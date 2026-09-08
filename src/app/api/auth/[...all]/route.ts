import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth/auth";

const handler = toNextJsHandler((request: Request) => getAuth().handler(request));
export const { GET, POST } = handler;
