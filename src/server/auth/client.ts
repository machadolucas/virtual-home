"use client";
import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

/** Browser-side auth client. Same-origin; never import server auth from client code. */
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});

export const { useSession, signOut } = authClient;
