"use client";
import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

/** Browser-side auth client. Same-origin; never import server auth from client code. */
export const authClient = createAuthClient({
  plugins: [usernameClient(), passkeyClient()],
});

export const { useSession, signOut } = authClient;
