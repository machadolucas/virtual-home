# Security

## Trust model
One household with equal access to everyday shared data. Owners additionally manage accounts;
members manage their own profile/security. Fresh browser authentication and a live owner check
protect changes to other accounts. No tenancy, public signup, impersonation or hard account deletion.
The local CLI remains the recovery and first-owner bootstrap path. Every mutation records its actor.

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

## Passkeys
`@better-auth/passkey` (pinned with `better-auth`) adds WebAuthn passkeys **alongside** the password;
an account is never passkey-only. Why: browsers match saved passwords on the registrable domain, so
every app under one parent domain is offered the same logins. A passkey is bound to its RP ID — the
exact hostname of `VH_BASE_URL` — so only this app's passkeys are ever offered here.

- **RP ID / origin** derive from `VH_BASE_URL` (no extra configuration). The RP ID cannot be an IP
  address: development and e2e use `http://localhost:<port>`. Changing the public hostname
  invalidates every registered passkey (passwords keep working).
- **Discoverable credentials only** (`residentKey: required`): sign-in starts without a username —
  the "Sign in with passkey" button, and conditional UI (`autocomplete="username webauthn"`, the
  browser lists passkeys in the username autofill). User verification is `preferred`.
- **Registration** needs a signed-in session *that signed in within the last 10 minutes*
  (`PASSKEY_REGISTRATION_MAX_SESSION_AGE_MS`). The plugin's own `freshSessionMiddleware` is a no-op
  here because `session.freshAge` is 0 (list-sessions needs that), and a passkey is a credential
  that survives a password change — so a stolen session cookie must not be able to plant one. A
  `hooks.before` guard in `buildAuthOptions` refuses `/passkey/generate-register-options` (without
  its challenge `verify-registration` cannot succeed) with `403 PASSKEY_REAUTH_REQUIRED` when
  `session.createdAt` is older than the window; the Security page then offers "sign in again"
  (sign out → `/login?next=/settings/security`). A password or a passkey sign-in both mint a new
  session and so both count as recent. The guard is in every instance `buildAuthOptions` builds,
  CLI variants included (they never register passkeys — that needs a browser ceremony).
  **Residual risk:** an attacker holding a cookie for a session created less than 10 minutes ago
  (a cookie stolen right after sign-in) can still register a passkey; deleting unknown passkeys
  in Security, or the owner's "Remove passkeys", recovers from that, and a password change alone
  does not. The guard also does not stop an attacker who knows the password — they can sign in
  themselves. The default name comes from the authenticator's AAGUID (`src/domain/passkeyProviders.ts`) or the
  registering browser; users rename and delete their own passkeys there. Public keys and credential
  IDs are never shown.
- **Sign-in** goes through `session.create.before`, the same hook as passwords, so an inactive or
  banned member's passkey is refused (generic 401) and mints no session. The signature counter is
  checked, so a cloned authenticator with a stale counter is refused.
- **Rate limits** (per IP): `generate-authenticate-options` 20/min (every login page load starts a
  conditional request), `verify-authentication` 5/min, other `/passkey/*` 30/min.
- **Removal is explicit.** A password reset (`set-password`, owner reset) and deactivation **keep**
  passkeys. The owner's "Remove passkeys" (audited `passkeys_removed`) and
  `pnpm vh-admin remove-passkeys <user>` delete them; neither touches sessions — sign devices out
  with a password reset or `revoke-sessions`. A lost device: remove its passkey (or all of the
  member's) *and* revoke sessions.

## Headers
CSP `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self';
img-src 'self' blob: data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), payment=(),
publickey-credentials-get=(self), publickey-credentials-create=(self)` (WebAuthn for this origin only,
so passkeys work and no embedded frame could use them). HSTS is Caddy's job.

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

## Household access lifecycle

`member_access` holds owner/member authority separately from generic authentication-plugin roles.
Missing rows mean active member, never owner; an explicit local `bootstrap-owner <username>`
selects the first owner from an existing account. No household identity appears in migrations.
The browser blocks generic auth-admin endpoints and exposes only audited household actions.
Deactivation preserves historical attribution, reassigns active work, revokes sessions and MCP
credentials, and suppresses future notifications. It keeps passkeys (sign-in is refused while
inactive; reactivation restores them); "Remove passkeys" is the separate, explicit action. Restoring access does not restore credentials.
Last-owner checks run in the write transaction; inactive users are checked on browser and MCP
authorization and omitted from assignment/recipient lists. User administration remains outside MCP.
