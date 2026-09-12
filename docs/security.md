# Security

## Trust model
Two household members with equal rights over shared data. The only privileged tier is shell access
to the server (recovery CLI). No roles, no tenancy. Every mutation records the actor for audit.

## Boundaries
- `requireSession()` in browser route handlers, server actions and pages (`authed()`/`action()` wrappers).
  The exact `/mcp` endpoint instead requires independently validated scoped bearer authentication on every request.
  `src/proxy.ts` is optimistic (cookie presence only) and adds `Cache-Control: private, no-store` to HTML.
- Private files (model package, attachments, exports, backups) live under `VH_DATA_DIR`, never `public/`,
  and are served only by authenticated handlers with `Cache-Control: private`, sniffed content types,
  `nosniff`, RFC 5987 dispositions and path containment (`safeJoin`: no `..`, separators, NUL, symlinks).
- SSE requires a session; client count is capped.
- HA long-lived token: server-side only (`secrets/vh.env`, 0600). Never in client bundles, URLs or logs
  (pino redaction + CI grep of the built bundle).
- Notification actions: nonce + recipient + occurrence + offered-actions validation; replay blocked by a
  unique index and by `completion.request_id`.

## Sessions and passwords
Better Auth username + password (min 12 chars), no public sign-up, no email. 30-day sliding sessions,
`sameSite=lax`, `httpOnly`, Secure iff https base URL, 60 s cookie cache (fresh check for security
pages and destructive actions). Login rate limit 5/min per IP (`x-forwarded-for` from Caddy; app is
loopback-bound). Recovery: `pnpm vh-admin set-password <user>` on the server.

## Headers
CSP `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self';
img-src 'self' blob: data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()`. HSTS is Caddy's job.

## Uploads
Streamed to `tmp/` with a hard byte cap, magic-byte sniffed (JPEG/PNG/WebP/HEIC/AVIF/PDF), PDFs with
`/JavaScript`, `/JS`, `/OpenAction` rejected, images re-encoded to metadata-free web/thumb copies,
originals stripped of GPS.

## Checklist for new endpoints
1. Starts with `requireSession()` (via `authed`/`action`), or the documented exact `/mcp` bearer boundary. 2. zod-validated input. 3. Idempotency key
for mutations. 4. `safeJoin` for any filesystem path. 5. Generic error bodies; details to logs with
`reqId`. 6. Actor recorded. 7. Tests: unauthenticated → 401/redirect.


## AI connections

Credentials are named, scoped, expiring and tied to an existing household user. Secrets are shown once; only their hashes are stored. Creation, rotation, revocation and consequential request approval use fresh browser sessions. Revocation is checked again inside streamed upload registration. Neither arbitrary SQL/filesystem access nor credentials, user administration, backup/restore or model import are exposed as MCP tools. Local client credentials belong in private files outside the repository.

All MCP requests validate Host and any Origin, bound request and response sizes and reject cookie-only access. Approval records contain immutable operation payloads and target revisions; expired or changed targets cannot execute. Requests cannot approve themselves. Keep the existing HTTPS/LAN boundary; MCP does not require a tunnel or public internet exposure.
