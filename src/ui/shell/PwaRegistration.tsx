"use client";

import { useEffect } from "react";

/** Register the small public-shell worker after hydration. Unsupported or insecure browsers keep
 * working as ordinary web clients, so registration failure never blocks the app. */
export function PwaRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
  }, []);

  return null;
}
