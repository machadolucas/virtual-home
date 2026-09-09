import type { NextConfig } from "next";

const external = new URL(process.env.VH_BASE_URL ?? "http://localhost:3010");

const csp = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  // Two trusted users on a private origin; nonce-based CSP is deliberately not used (see docs/security.md).
  // React dev tooling needs eval; production never gets it.
  process.env.NODE_ENV === "production"
    ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  ...(external.protocol === "https:" ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  // Next 16 blocks dev-only resources (`_next/hmr`, devtools) from any host but the one the dev
  // server was opened on, and a blocked HMR socket leaves the page un-hydrated with no visible
  // error. Development is reached over the loopback names and over the LAN while testing on a
  // phone, so all three are allowed. Production is unaffected: this key only applies to `next dev`.
  allowedDevOrigins: ["localhost", "127.0.0.1", "[::1]", "*.local"],
  serverExternalPackages: ["better-sqlite3", "sharp", "pino", "pino-roll", "pino-pretty"],
  poweredByHeader: false,
  typedRoutes: true,
  experimental: {
    serverActions: {
      allowedOrigins: [external.host],
      bodySizeLimit: "30mb",
    },
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // Everything except `_next/*`: these headers belong on documents and API responses, and
        // appending them to the dev HMR WebSocket's 101 upgrade corrupts the handshake in Chrome
        // (`ERR_INVALID_HTTP_RESPONSE`), which leaves the dev client retrying and the page
        // un-hydrated. Static chunks gain nothing from a CSP.
        source: "/((?!_next/).*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
