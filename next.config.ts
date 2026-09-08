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
        source: "/:path*",
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
