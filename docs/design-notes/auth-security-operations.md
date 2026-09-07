I have enough verified ground truth. Several findings materially change the design, so I'll lead with those.

---

# virtual-home — Platform Design (auth, files, transport, ops)

> Status: implementation-ready design. Target: Apple Silicon Mac mini, macOS 27, Node 24, Next.js 16.3, pnpm 11.
> Everything below was checked against the live environment or upstream docs; §0 lists the checks that **changed** the design.

## 0. Verified findings that changed this design

These were measured on the dev machine (`macOS 27.0 / arm64 / node v24.16.0 / pnpm 11.25.0`), not assumed. Each one invalidates an obvious-but-wrong choice.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| 1 | **`tar --zstd` "works" but barely compresses.** | `tar --zstd -cf - /etc/hosts` → 10240 bytes with valid zstd magic `28b5 2ffd`; `tar -cf - \| zstd -q -c` → **308 bytes**. `bsdtar 3.5.3` is linked against `zlib/liblzma/bz2lib` only — no zstd in the banner. | `backup.sh` must **pipe** through `/opt/homebrew/bin/zstd`, never use `tar --zstd`. A 33× regression that exits 0 is exactly the bug nobody notices. |
| 2 | **sharp's prebuilt binary has no HEIC decode.** | sharp install docs list prebuilt input as "JPEG, PNG, Ultra HDR, WebP, AVIF, TIFF, GIF and SVG". AVIF ≠ HEIC; libheif's HEVC decoder is omitted for patent reasons. | HEIC uploads from iPhones would fail. Fallback is **`/usr/bin/sips`**, which is already present and lists `public.heic … Writable`, `public.heif`, `public.avif`, `public.jpeg-xl`. Zero new dependencies, macOS-native. |
| 3 | **All Better Auth `admin` plugin endpoints require admin session headers** — `createUser`, `setUserPassword`, `listUsers`, `revokeUserSessions`, every one. | Admin plugin docs. | A headless CLI **cannot** use them (chicken-and-egg: no session exists before the first user). The recovery CLI must use a different, session-free path — see §4. This is the single biggest correction to the brief. |
| 4 | **`auth.api.forgetPassword` is now `auth.api.requestPasswordReset`**, and neither it nor `resetPassword` needs a session. | Email/password docs. | Gives a **100 % public-API, session-free** password path for the CLI. Design §4 is built on it. |
| 5 | **The existing nginx cert on this host is self-signed with a 10-year lifetime** (`issuer == subject = O=Demola Oy`, `notAfter Jan 19 2035`, SAN `*.local.demola.net`). | `openssl x509 -noout -issuer -subject -dates -ext subjectAltName`. | **Do not copy the existing pattern for virtual-home.** iOS rejects TLS leaf certs with validity > 825 days outright. iPhones opening HA notification links would hard-fail. mkcert (≈2 y 3 m leaves) is required. |
| 6 | **Port 3000 is already a `proxy_pass` target** (`hub.local.demola.net → http://localhost:3000`). | `grep proxy_pass /opt/homebrew/etc/nginx/nginx.conf`. | Default `PORT=3010`, and the installer must fail loudly if the port is taken. |
| 7 | **Homebrew nginx binds :443 as a non-root user agent on this host.** | `ps -o user=` shows master process owned by `machadolucas`; `net.inet.ip.portrange.reservedlow` sysctl does not exist on Darwin. | No root LaunchDaemon needed for TLS. Config drops into `/opt/homebrew/etc/nginx/servers/` (already `include servers/*;` at line 352). Verify on the mini rather than assume. |
| 8 | **`entity_registry_updated` carries *old* values under `changes`.** | home-assistant/core issues #134613, #152288; the HA frontend itself does a full `list_for_display` refresh on the event. | Never patch local registry state from the event payload. Treat the event purely as a **cache-invalidation signal** and re-`list`. |
| 9 | **HA device registry API changed in Core 2026.8–2026.9.** | HA dev blog 2026-08-19. | `config/device_registry/list` is still fine (additive), but the parser must tolerate **child devices** with reduced serialization (no hardware fields) and prefer `config_entry_id` over the deprecated `config_entries`. `remove_config_entry` is removed in 2027.9. |
| 10 | **`serverActions.allowedOrigins` is still under `experimental`** in Next 16.3.4, and ports cannot be wildcarded. | Next 16.3.4 docs. | Config shape in §2; if TLS ends up on :8443, the entry must be written `home.example.net:8443` in full. |
| 11 | `mkcert` is **not installed**; `zstd`, `sqlite3 3.54.0`, `exiftool`, `openssl`, `sips` are. | `command -v` sweep. | Installer must `brew install mkcert nss`. `exiftool` availability makes lossless GPS stripping of stored originals practical (§9). |

---

## 1. Repository layout

```
virtual-home/
├─ app/
│  ├─ (auth)/login/page.tsx
│  ├─ (app)/layout.tsx                  # calls requireSession()
│  ├─ (app)/settings/security/page.tsx  # session list + password change
│  ├─ (app)/settings/system/page.tsx    # observability page
│  └─ api/
│     ├─ auth/[...all]/route.ts         # toNextJsHandler(auth)
│     ├─ health/route.ts                # unauthenticated, no data
│     ├─ events/route.ts                # SSE
│     ├─ attachments/[id]/route.ts      # authed file streaming
│     ├─ attachments/[id]/thumb/route.ts
│     ├─ upload/route.ts                # multipart ingest
│     ├─ model/[...path]/route.ts       # authed model assets
│     └─ ha/history/route.ts            # on-demand HA REST proxy
├─ proxy.ts                             # Next 16: NOT middleware.ts
├─ instrumentation.ts                   # register(): env validation + boot log
├─ next.config.ts
├─ drizzle/                             # committed SQL migrations
├─ src/
│  ├─ env.ts                            # zod, shared by web/worker/cli
│  ├─ domain/                           # pure logic, shared by both processes
│  ├─ db/{client.ts,schema/*.ts,migrate.ts}
│  ├─ server/
│  │  ├─ auth/{auth.ts,client.ts,session.ts,provisioning.ts}
│  │  ├─ events/{hub.ts,outbox.ts}
│  │  ├─ files/{store.ts,images.ts,sniff.ts}
│  │  └─ log.ts
│  └─ worker/
│     ├─ index.ts
│     ├─ ha/{socket.ts,registry.ts,notify.ts,rest.ts}
│     └─ jobs/{heartbeat.ts,metrics.ts}
├─ scripts/
│  ├─ install-macmini.sh  update.sh  backup.sh  restore.sh
│  ├─ vh-admin.ts
│  ├─ measure-resources.sh
│  └─ launchd/{run-web.sh,run-worker.sh,net.machadolucas.virtual-home.*.plist}
├─ tests/{unit,e2e,fixtures/model/}      # synthetic fixture model only
├─ docs/{architecture,data-model,decisions,operations,security,model-contract,ux}.md
├─ CLAUDE.md            AGENTS.md -> CLAUDE.md   (symlink)
└─ .env.example  .gitignore
```

`.gitignore` — the GitHub remote is public, so this is a security control, not hygiene:

```gitignore
.env
.env.*
!.env.example
data/
*.db
*.db-wal
*.db-shm
*.tar.zst
*.tar.gz
node_modules/
.next/
/model/            # real model package never enters the repo
/attachments/
tests/fixtures/model/*.glb.real
*.heic
*.jpg
*.jpeg
*.png
!public/**/*.png   # only committed app chrome
!tests/fixtures/**/*.png
```

`AGENTS.md` is a symlink to `CLAUDE.md` (`ln -s CLAUDE.md AGENTS.md`) so both tool ecosystems read one file. Contents outline: commands (`pnpm dev`, `pnpm worker:dev`, `pnpm test`, `pnpm db:generate`), the two-process model, "never put household data or photos in the repo", where decisions live (`docs/decisions.md`, ADR-lite), and the rule that every route handler starts with `requireSession()`.

---

## 2. Configuration

### 2.1 Env var contract

`VH_` prefixes app config; unprefixed names are ones the ecosystem dictates (`PORT`, `BETTER_AUTH_SECRET`).

| Key | Req | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | – | `development` | `production` on the mini |
| `VH_DATA_DIR` | ✅ | – | Absolute. All private state. e.g. `/Users/machadolucas/virtual-home-data` |
| `VH_BASE_URL` | ✅ | – | External origin, e.g. `https://home.machadolucas.net`. Drives cookie `secure` and Better Auth `baseURL` |
| `VH_TRUSTED_ORIGINS` | – | `VH_BASE_URL` | Comma list; wildcards (`*`,`**`,`?`) allowed |
| `VH_HOUSEHOLD_TZ` | – | `Europe/Helsinki` | IANA; validated against `Intl.supportedValuesOf('timeZone')` |
| `VH_DELIVERY_TIME` | – | `07:30` | `HH:MM` in `VH_HOUSEHOLD_TZ` |
| `HOST` | – | `127.0.0.1` | **Keep loopback behind nginx.** `0.0.0.0` only for the documented HTTP fallback |
| `PORT` | – | `3010` | Not 3000 (finding #6) |
| `LOG_LEVEL` | – | `info` | `trace…fatal` |
| `BETTER_AUTH_SECRET` | ✅ | – | ≥32 chars. Secret |
| `HA_URL` | ✅ | – | `http://192.168.1.181:8123` |
| `HA_TOKEN` | ✅ (worker) | – | Secret. Worker + `ha/history` route only |
| `HA_WS_URL` | – | *derived* | `http→ws`, `https→wss`, `+ /api/websocket` |
| `VH_EVENT_POLL_MS` | – | `1000` | Web outbox poll |
| `VH_SSE_MAX_CLIENTS` | – | `8` | Hard cap |
| `VH_WORKER_HEARTBEAT_MS` | – | `15000` | |
| `VH_METRICS_INTERVAL_MS` | – | `60000` | |
| `VH_UPLOAD_MAX_BYTES` | – | `26214400` | 25 MiB |
| `VH_BACKUP_RETAIN_DAILY` | – | `14` | |
| `VH_BACKUP_RETAIN_WEEKLY` | – | `8` | |
| `VH_SHOW_ACCOUNT_HINTS` | – | `true` | Pre-listed avatars on login; set `false` if ever public |
| `VH_HA_HISTORY_ENABLED` | – | `true` | Kill switch for the REST proxy |

Derived, never set by hand: `VH_DB_PATH = ${VH_DATA_DIR}/db/app.db`, `VH_MODEL_DIR`, `VH_ATTACH_DIR`, `VH_BACKUP_DIR`, `VH_EXPORT_DIR`, `VH_LOG_DIR`.

### 2.2 `src/env.ts`

Role-aware so the web process never *needs* `HA_TOKEN` to boot, and a typo in the worker's env can't silently degrade the web app.

```ts
import { z } from 'zod';
import path from 'node:path';

const Role = z.enum(['web', 'worker', 'cli']);
const bool = z.enum(['true','false']).transform(v => v === 'true');

const base = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  VH_DATA_DIR: z.string().min(1).refine(p => path.isAbsolute(p), 'must be absolute'),
  VH_BASE_URL: z.string().url(),
  VH_TRUSTED_ORIGINS: z.string().optional(),
  VH_HOUSEHOLD_TZ: z.string().default('Europe/Helsinki')
    .refine(tz => Intl.supportedValuesOf('timeZone').includes(tz), 'unknown IANA zone'),
  VH_DELIVERY_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('07:30'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  LOG_LEVEL: z.enum(['trace','debug','info','warn','error','fatal']).default('info'),
  BETTER_AUTH_SECRET: z.string().min(32),
  HA_URL: z.string().url(),
  HA_TOKEN: z.string().min(20).optional(),
  HA_WS_URL: z.string().url().optional(),
  VH_EVENT_POLL_MS: z.coerce.number().int().min(200).max(10_000).default(1000),
  VH_SSE_MAX_CLIENTS: z.coerce.number().int().min(1).max(64).default(8),
  VH_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(5_000).default(15_000),
  VH_METRICS_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  VH_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(26_214_400),
  VH_BACKUP_RETAIN_DAILY: z.coerce.number().int().min(1).default(14),
  VH_BACKUP_RETAIN_WEEKLY: z.coerce.number().int().min(1).default(8),
  VH_SHOW_ACCOUNT_HINTS: bool.default('true'),
  VH_HA_HISTORY_ENABLED: bool.default('true'),
});

export function loadEnv(role: z.infer<typeof Role>) {
  const p = base.safeParse(process.env);
  if (!p.success) {
    // Print field errors only — never values, which may contain HA_TOKEN.
    console.error('[env] invalid configuration:',
      JSON.stringify(p.error.flatten().fieldErrors, null, 2));
    process.exit(78); // EX_CONFIG
  }
  const e = p.data;
  if ((role === 'worker' || role === 'cli') && !e.HA_TOKEN && role === 'worker') {
    console.error('[env] HA_TOKEN is required for the worker'); process.exit(78);
  }
  const u = new URL(e.HA_URL);
  const haWs = e.HA_WS_URL ?? `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/api/websocket`;
  const secure = new URL(e.VH_BASE_URL).protocol === 'https:';
  return {
    ...e, role, haWs, cookieSecure: secure,
    trustedOrigins: (e.VH_TRUSTED_ORIGINS ?? e.VH_BASE_URL).split(',').map(s => s.trim()).filter(Boolean),
    dbPath:     path.join(e.VH_DATA_DIR, 'db', 'app.db'),
    modelDir:   path.join(e.VH_DATA_DIR, 'model'),
    attachDir:  path.join(e.VH_DATA_DIR, 'attachments'),
    backupDir:  path.join(e.VH_DATA_DIR, 'backups'),
    exportDir:  path.join(e.VH_DATA_DIR, 'exports'),
    logDir:     path.join(e.VH_DATA_DIR, 'logs'),
  } as const;
}
export type Env = ReturnType<typeof loadEnv>;
```

**Web-side validation runs in `instrumentation.ts`**, which Next executes once per server start before serving:

```ts
export async function register() {
  const { loadEnv } = await import('./src/env');
  const env = loadEnv('web');
  const { log } = await import('./src/server/log');
  log.info({ port: env.PORT, host: env.HOST, baseUrl: env.VH_BASE_URL }, 'web starting');
}
```

Exit code 78 (`EX_CONFIG`) matters operationally: `run-web.sh` treats it as fatal and does **not** let launchd thrash-restart on a config typo (§6.4).

### 2.3 `next.config.ts`

```ts
import type { NextConfig } from 'next';
const external = new URL(process.env.VH_BASE_URL ?? 'http://localhost:3010');
const csp = [
  "default-src 'self'", "base-uri 'none'", "object-src 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
  "img-src 'self' blob: data:", "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:", "connect-src 'self'", "manifest-src 'self'",
  ...(external.protocol === 'https:' ? ['upgrade-insecure-requests'] : []),
].join('; ');

const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'sharp', 'pino', 'pino-roll'],
  poweredByHeader: false,
  experimental: {
    serverActions: {
      allowedOrigins: [external.host],   // host incl. port; no wildcard for ports
      bodySizeLimit: '30mb',             // > VH_UPLOAD_MAX_BYTES + multipart overhead
    },
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=(), payment=()' },
      ],
    }];
  },
};
export default config;
```

`serverExternalPackages` is mandatory for `better-sqlite3` (native `.node` binding) and strongly advisable for `sharp`. Without it Turbopack tries to bundle the binding and the build fails at runtime, not build time.

**CSP justification (`script-src 'unsafe-inline'`).** Nonce-based CSP is *possible* in Next 16 (generate a nonce in `proxy.ts`, forward via header) but it forces every page that reads the nonce into dynamic rendering, and a nonce mismatch fails silently in a way that is hard for an AI maintainer to diagnose. This app has no third-party scripts, no ads, no user-supplied HTML, two trusted users, and a LAN-only surface. The dominant XSS vector would be our own markup, and React escapes by default. So: accept `'unsafe-inline'` for scripts and add compensating controls — ESLint `react/no-danger` as an **error**, a grep gate in CI for `dangerouslySetInnerHTML`, and `object-src 'none'` + `base-uri 'none'` to kill the classic bypasses. `'wasm-unsafe-eval'` is needed for Draco/KTX2 WASM decoders in R3F; `worker-src blob:` for their worker bootstrap. Revisit if the cloudflared tunnel ever exposes this publicly — that's an ADR trigger recorded in `docs/decisions.md`.

---

## 3. Auth design

### 3.1 `src/server/auth/auth.ts`

Options are produced by a **factory** so the recovery CLI can build a variant instance (§4) from one source of truth.

```ts
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { username, admin } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { db } from '@/db/client';
import * as schema from '@/db/schema/auth';
import { loadEnv } from '@/env';
import { log } from '@/server/log';

export type AuthVariant = { allowSignUp?: boolean; captureResetToken?: (t: string, email: string) => void };

export function buildAuthOptions(v: AuthVariant = {}): BetterAuthOptions {
  const env = loadEnv('web');
  return {
    appName: 'virtual-home',
    baseURL: env.VH_BASE_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    telemetry: { enabled: false },
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),

    emailAndPassword: {
      enabled: true,
      disableSignUp: v.allowSignUp !== true,   // true in the web instance
      requireEmailVerification: false,          // no mail transport exists
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 15,
      // Never emails. Web instance: log-and-drop. CLI instance: capture in-process.
      sendResetPassword: async ({ user, token }) => {
        if (v.captureResetToken) return v.captureResetToken(token, user.email);
        log.warn({ userId: user.id }, 'password reset requested; use scripts/vh-admin.ts set-password');
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,   // 30 days
      updateAge: 60 * 60 * 24,        // sliding refresh once/day
      freshAge: 60 * 10,              // password change needs a session <10min old
      cookieCache: { enabled: true, maxAge: 60 },  // see tradeoff below
    },

    trustedOrigins: () => env.trustedOrigins,

    rateLimit: {
      enabled: true,
      storage: 'database',            // survives restarts; memory would not
      modelName: 'rateLimit',
      window: 60,
      max: 120,
      customRules: {
        '/sign-in/username': { window: 60, max: 5 },
        '/sign-in/email':    { window: 60, max: 5 },
        '/reset-password':   { window: 300, max: 5 },
        '/request-password-reset': { window: 300, max: 3 },
      },
    },

    advanced: {
      useSecureCookies: env.cookieSecure,
      cookiePrefix: 'vh',
      defaultCookieAttributes: { sameSite: 'lax', secure: env.cookieSecure, httpOnly: true, path: '/' },
      database: { generateId: 'uuid' },
      // nginx terminates TLS; without this every request looks like it came from 127.0.0.1
      // and the sign-in rate limit becomes a single global bucket.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },

    user: { additionalFields: { displayColor: { type: 'string', required: false, input: false } } },

    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 30 }),
      admin(),          // kept for typed schema parity; endpoints unused (finding #3)
      nextCookies(),    // MUST be last
    ],
  };
}

export const auth = betterAuth(buildAuthOptions());
```

Notes that matter:

- **`ipAddress.ipAddressHeaders`** is not optional cosmetics. Behind nginx, every request's socket address is `127.0.0.1`; without this the `/sign-in/username` limit of 5/min applies to *both users combined*, and a brute-force from one device locks out the other. `x-forwarded-for` is trustworthy here **only because** nginx overwrites it (§5.3) and the app port is bound to loopback.
- **`sameSite: 'lax'`** (not `strict`) is required: HA notifications open `https://home…/thing/123` as a top-level cross-site navigation from the HA app. `strict` would drop the cookie and bounce the user to login every time — the single most likely "why am I logged out?" bug in this app.
- **Cookie cache tradeoff.** `cookieCache` stores a signed session snapshot in the cookie so `getSession` skips a DB read. Cost: a revoked session keeps working for up to `maxAge`. I set **60 s** (not the doc's 300) so `vh-admin revoke-sessions` takes effect within a minute, and provide `requireFreshSession()` (below) which passes `query: { disableCookieCache: true }` for anything destructive. 60 s of staleness on read paths is a good trade; 5 minutes on a security page is not.
- **`disableSignUp: true`** closes `/sign-up/email`. Combined with no `socialProviders` and no email transport, the only account-creation path is the CLI.
- Synthetic emails: `lucas@virtual-home.local`, `marja@virtual-home.local`. `emailAndPassword` requires an email; nothing sends mail. Usernames `lucas`/`marja` are the real credential.

### 3.2 `src/server/auth/client.ts`

```ts
import { createAuthClient } from 'better-auth/react';
import { usernameClient } from 'better-auth/client/plugins';
export const authClient = createAuthClient({ plugins: [usernameClient()] });
export const { signIn, signOut, useSession, changePassword, listSessions, revokeSession } = authClient;
```

No `baseURL` — same-origin. Never import `auth.ts` (server) into a client component; enforce with an ESLint `no-restricted-imports` rule on `@/server/**` from `app/**/*.client.tsx`.

### 3.3 `proxy.ts` (Next 16 — Node runtime, no `export const runtime`)

Purpose: a cheap optimistic gate plus HTML cache headers. **It is not the security boundary.**

```ts
import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (!getSessionCookie(request)) {
    if (request.headers.get('sec-fetch-mode') === 'navigate') {
      const url = new URL('/login', request.url);
      url.searchParams.set('next', pathname + search);
      return NextResponse.redirect(url);
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const res = NextResponse.next();
  if (request.headers.get('sec-fetch-mode') === 'navigate') {
    res.headers.set('Cache-Control', 'private, no-store, must-revalidate');
  }
  return res;
}

export const config = {
  matcher: [
    // Everything except: auth endpoints, health, login, Next internals, static files.
    '/((?!api/auth|api/health|login|_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest).*)',
  ],
};
```

`getSessionCookie` only checks for cookie *presence* — it does not verify the signature or hit the DB. That is deliberate and documented in `docs/security.md`: it exists to avoid rendering work and to redirect nicely. A forged cookie sails past it and is then rejected by `requireSession()`.

### 3.4 `requireSession()` — the real boundary

```ts
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from './auth';

export type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export const getSession = cache(async (): Promise<Session | null> =>
  auth.api.getSession({ headers: await headers() }));

export const getFreshSession = async (): Promise<Session | null> =>
  auth.api.getSession({ headers: await headers(), query: { disableCookieCache: true } });

/** API routes / server actions: throws a 401-carrying error. */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new UnauthorizedError();
  return s;
}
/** Destructive ops, /settings/security: bypasses the 60s cookie cache. */
export async function requireFreshSession(): Promise<Session> {
  const s = await getFreshSession();
  if (!s) throw new UnauthorizedError();
  return s;
}
/** Pages: redirects to /login?next=… */
export async function requireSessionPage(nextPath: string): Promise<Session> {
  const s = await getSession();
  if (!s) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return s;
}

export class UnauthorizedError extends Error {
  status = 401 as const;
  constructor() { super('unauthorized'); this.name = 'UnauthorizedError'; }
}
```

`cache()` dedupes within one request render, so a layout + three server components cost one session resolution.

**Authorization model:** any authenticated member reads and writes all household data. There are no roles. The only privileged tier is physical/SSH access to the mini (the recovery CLI). This is written into `docs/security.md` explicitly so nobody later "adds an admin role" and creates a half-enforced boundary. Every mutation still records `actorUserId` for attribution — audit, not permission.

### 3.5 Route handler + server action patterns

```ts
// src/server/api/handler.ts
export function authed<T>(fn: (s: Session, req: Request, ctx: T) => Promise<Response>) {
  return async (req: Request, ctx: T): Promise<Response> => {
    const started = performance.now();
    try {
      const s = await requireSession();
      return await fn(s, req, ctx);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        return Response.json({ error: 'unauthorized' }, { status: 401,
          headers: { 'Cache-Control': 'private, no-store' } });
      }
      if (e instanceof z.ZodError) {
        return Response.json({ error: 'invalid_request', issues: e.flatten() }, { status: 400 });
      }
      log.error({ err: e, url: req.url }, 'handler failed');
      return Response.json({ error: 'internal' }, { status: 500 });
    } finally {
      log.debug({ url: req.url, ms: Math.round(performance.now() - started) }, 'req');
    }
  };
}
```

Server actions get a wrapper with zod + idempotency:

```ts
// src/server/api/action.ts
export function action<I extends z.ZodTypeAny, O>(input: I, run: (v: z.infer<I>, s: Session) => Promise<O>) {
  return async (raw: unknown): Promise<{ ok: true; data: O } | { ok: false; error: string }> => {
    const s = await requireSession();
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };
    const { idempotencyKey, ...rest } = parsed.data as { idempotencyKey?: string };

    if (idempotencyKey) {
      const hit = db.select().from(idempotency).where(eq(idempotency.key, idempotencyKey)).get();
      if (hit) return JSON.parse(hit.responseJson);
    }
    const data = await run(parsed.data, s);
    const result = { ok: true as const, data };
    if (idempotencyKey) {
      db.insert(idempotency).values({
        key: idempotencyKey, userId: s.user.id, responseJson: JSON.stringify(result),
        createdAt: new Date(),
      }).onConflictDoNothing().run();
    }
    return result;
  };
}
```

Client supplies `idempotencyKey: crypto.randomUUID()` generated **once per form instance** (in a `useRef`), not per submit — that's what makes a double-tap or a retry-after-timeout safe. Reaper deletes keys older than 24 h.

### 3.6 Session revocation UI & password change (`/settings/security`)

Server component calls `requireFreshSession()`, then `auth.api.listSessions({ headers: await headers() })`. Render each session with user-agent-derived label ("iPhone · Safari"), IP, created/expires, and a "This device" marker matched on session token. Actions:

- **Revoke one** → `authClient.revokeSession({ token })`
- **Sign out everywhere else** → `authClient.revokeOtherSessions()`
- **Change password** → `authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true })`. `session.freshAge: 600` means a session older than 10 minutes gets re-prompted; the UI must handle that error by asking for a re-login rather than showing a raw error.

There is deliberately **no** "forgot password" link. The page says: *"Lost your password? It can only be reset from the Mac mini: `pnpm vh-admin set-password <username>`."* That's honest about the trust model and avoids building an email-less reset flow with a weak recovery channel.

### 3.7 Login page UX

**Recommendation: yes, pre-list the two accounts as avatar buttons** (behind `VH_SHOW_ACCOUNT_HINTS`). Rationale: user enumeration is the standard objection, but with exactly two accounts on a LAN app whose hostname is already private, enumeration protection buys nothing while costing real daily friction — nobody wants to type `marja` on an iPhone keyboard every time. Clicking an avatar sets `username` and focuses the password field.

Details:
- Names/colors come from the DB (`user.name`, `user.displayColor`), not hardcoded.
- Hidden `<input name="username" autoComplete="username">` stays in the DOM so iOS Passwords offers to fill and save.
- Password field: `autoComplete="current-password"`, `type="password"`, `enterKeyHint="go"`.
- "Keep me signed in" checkbox, **default checked**, wired to `rememberMe` on `signIn.username`. With `expiresIn: 30d` + `updateAge: 1d`, an active user effectively never re-authenticates; an untouched session dies in 30 days.
- Failed login: one generic message ("Wrong username or password") regardless of cause, but rate-limit rejections say "Too many attempts, wait a minute" — distinguishing *lockout* from *wrong password* is a usability win with no security cost.
- After success, redirect to the validated `next` param: accept only same-origin **relative** paths matching `/^\/(?!\/)/`, else `/`. Blocks open redirect from a crafted HA notification link.
- `viewport-fit=cover`, `theme-color`, and `apple-mobile-web-app-capable` so the HA in-app browser looks right.

---

## 4. Provisioning & recovery CLI (`scripts/vh-admin.ts`)

**This is where finding #3 forces a redesign.** The brief assumed `auth.api.createUser` / `setUserPassword` / `revokeUserSessions` / `listUsers` were callable headlessly. They are not — every admin-plugin endpoint requires admin session headers, and no session can exist before the first user does.

Three candidate paths were evaluated:

| Path | Verdict |
|---|---|
| Admin plugin endpoints | ❌ Impossible without a pre-existing admin session. |
| `auth.$context` → `ctx.internalAdapter.createUser/createAccount` + `ctx.password.hash` | ⚠️ Works and is the community-standard workaround, but `internalAdapter` is **not documented as stable API**. A minor Better Auth bump could silently change hashing or account shape and lock both users out of their own house. |
| **Public API only, via a variant auth instance** | ✅ **Chosen.** |

### 4.1 The chosen mechanism

Run the CLI in-process against the same SQLite file, using an auth instance built from `buildAuthOptions()` with two overrides:

1. **User creation** — `allowSignUp: true` flips `disableSignUp` off *for this process only*, making `auth.api.signUpEmail` (a documented public endpoint that needs no session) legal. The username plugin extends the sign-up body with `username`.
2. **Password reset** — `captureResetToken` intercepts the token in-process. `auth.api.requestPasswordReset` (no session required, finding #4) generates it, the callback hands it to a local variable instead of an email, then `auth.api.resetPassword({ body: { newPassword, token } })` completes it. Fully supported endpoints, correct hashing, correct side effects, no internals.
3. **Listing / revoking sessions** — plain Drizzle reads and deletes against the `session` table. That table is part of *our* schema (we generate its migration), so this is ordinary data access, not an internals gamble.

```ts
// scripts/vh-admin.ts
import { betterAuth } from 'better-auth';
import { buildAuthOptions } from '@/server/auth/auth';
import { db } from '@/db/client';
import { user, session } from '@/db/schema/auth';
import { eq, lt } from 'drizzle-orm';
import { loadEnv } from '@/env';
import { promptHidden, promptLine } from './lib/prompt';

const env = loadEnv('cli');

async function createUser(username_: string, name: string) {
  const email = `${username_}@virtual-home.local`;
  const pw = await promptHidden(`Password for ${username_} (min 12): `);
  if ((await promptHidden('Repeat: ')) !== pw) throw new Error('passwords differ');
  const provisioning = betterAuth(buildAuthOptions({ allowSignUp: true }));
  await provisioning.api.signUpEmail({
    body: { email, password: pw, name, username: username_, displayUsername: name },
  });
  console.log(`created ${username_} <${email}>`);
}

async function setPassword(username_: string) {
  const row = db.select().from(user).where(eq(user.username, username_.toLowerCase())).get();
  if (!row) throw new Error(`no such user: ${username_}`);
  const pw = await promptHidden(`New password for ${username_}: `);
  if ((await promptHidden('Repeat: ')) !== pw) throw new Error('passwords differ');

  let token: string | undefined;
  const resetter = betterAuth(buildAuthOptions({ captureResetToken: t => { token = t; } }));
  await resetter.api.requestPasswordReset({ body: { email: row.email, redirectTo: '/login' } });
  if (!token) throw new Error('reset token was not produced — check sendResetPassword wiring');
  await resetter.api.resetPassword({ body: { newPassword: pw, token } });

  const n = db.delete(session).where(eq(session.userId, row.id)).run().changes;
  console.log(`password updated; revoked ${n} session(s)`);
  console.warn('cookie cache may keep old sessions alive for up to 60s');
}

async function revokeSessions(target: string) {
  if (target === '--all') {
    console.log(`revoked ${db.delete(session).run().changes} session(s)`);
    return;
  }
  const row = db.select().from(user).where(eq(user.username, target.toLowerCase())).get();
  if (!row) throw new Error(`no such user: ${target}`);
  console.log(`revoked ${db.delete(session).where(eq(session.userId, row.id)).run().changes} session(s)`);
}
```

Commands:

| Command | Effect |
|---|---|
| `init-users` | Interactive; creates `lucas` and `marja` if absent. Idempotent — skips existing. |
| `create-user <username> <name>` | Single user. |
| `list-users` | username, name, email, created, active session count, last session activity. |
| `set-password <username>` | Reset-token flow above; revokes that user's sessions. |
| `revoke-sessions <username\|--all>` | Session table delete. |
| `prune-sessions` | `DELETE FROM session WHERE expires_at < now` (also run hourly by the worker). |
| `ha-token-check` | `GET ${HA_URL}/api/` with the token; prints HTTP status + `message`, never the token. |
| `model-fingerprint` | Recompute and print; useful after dropping in a new model package. |
| `doctor` | Env validation, dir perms (expects `700`/`600`), `PRAGMA integrity_check`, migration drift, HA reachability, launchd job states, disk free. |

Wired as `pnpm vh-admin <cmd>` → `tsx scripts/vh-admin.ts`. Runs entirely over the local DB file; **no HTTP, no session, no network** except `ha-token-check`.

`promptHidden` disables echo properly (`process.stdin.setRawMode(true)`, collect until `\r`, handle `\x03` → exit 130), and the CLI refuses to run if `!process.stdin.isTTY` unless `--password-from-stdin` is passed — so a password can never end up in shell history via an argv flag.

### 4.2 Contract test (this is what makes the design safe)

Whatever mechanism is used, a version bump must not be able to lock the household out silently. `tests/unit/auth-provisioning.test.ts`:

1. Fresh temp DB, run all migrations.
2. `create-user` path → assert `auth.api.signInUsername({ body: { username, password } })` returns a session.
3. `set-password` path → assert the **old** password now fails and the **new** one succeeds.
4. Assert the pre-existing session token is gone from `session`.
5. Assert `disableSignUp` still blocks `/sign-up/email` on the **web** instance (i.e. the variant didn't leak).

`better-auth` is pinned exactly (`"better-auth": "1.7.x"` → exact version, no `^`) and this test runs in CI, so a Renovate bump that breaks provisioning fails the build instead of the house.

### 4.3 Secrets

Location: `${VH_DATA_DIR}/secrets/vh.env`, mode `0600`, dir `0700`, owned by the login user. Never in the repo, never in a plist (`launchctl print` and `ps -E` can expose plist env; a sourced file is not in the process argv).

```bash
# generation
BETTER_AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
```

`HA_TOKEN`: create in HA → profile → Security → Long-lived access tokens, name it `virtual-home-worker`, paste into `vh.env`. Never printed by any script; log redaction (§11) covers `ha_token`, `access_token`, `authorization`, `password`, `token`, `cookie`.

**Rotation — `BETTER_AUTH_SECRET`:** it signs session cookies and the reset tokens, so rotation invalidates every session. Procedure: (1) `scripts/backup.sh`; (2) edit `vh.env`; (3) `launchctl kickstart -k gui/$(id -u)/net.machadolucas.virtual-home.web`; (4) `pnpm vh-admin revoke-sessions --all` to purge now-unverifiable rows; (5) both users sign in again. Not urgent unless leaked; annually is fine.

**Rotation — `HA_TOKEN`:** (1) create a new long-lived token in HA; (2) update `vh.env`; (3) `launchctl kickstart -k gui/$(id -u)/net.machadolucas.virtual-home.worker`; (4) confirm `/settings/system` shows HA `connected` and `lastOkAt` moved; (5) **only then** delete the old token in HA. Order matters — deleting first means a reconnect storm with `auth_invalid` (§8.3).

---

## 5. HTTPS, hostname, nginx

### 5.1 Recommendation: option 2 (nginx TLS terminator + mkcert), on a real DNS name

**Chosen:** a real subdomain of a domain the owner controls, with a **public A record pointing at the mini's LAN IP**, TLS terminated by the existing Homebrew nginx using an **mkcert**-issued cert, proxying to `127.0.0.1:3010`.

```
home.machadolucas.net.  A  192.168.1.50      (mini's static LAN IP)
```

Why this and not the alternatives:

- **vs. `home.local` (mDNS).** `.local` resolution from iPhones is real but flaky over Wi-Fi roaming and sleep, cannot ever be used with a public cert, and is a dead end for the cloudflared plan. A real name works identically on LAN today and through a tunnel tomorrow with only a DNS change.
- **vs. plain HTTP + `useSecureCookies: false`.** Documented as the emergency fallback only. It costs Secure cookies, means passwords cross the LAN in cleartext, and — the practical killer — iOS increasingly warns/degrades on HTTP form submission, plus `upgrade-insecure-requests` and any future PWA/service-worker work are off the table.
- **vs. Next.js terminating TLS itself.** `next start` has no first-class TLS story; nginx is already running, already binds :443 (finding #7), and is the right tool for SSE buffering control and `client_max_body_size`.
- **Do not reuse the existing `*.local.demola.net` cert** — finding #5: it is self-signed with a 10-year lifetime, which **iOS rejects outright** (>825 days). It would fail exactly on the devices that matter.

Forward path: when cloudflared arrives, either give the tunnel a different hostname (`vh.machadolucas.net`) and keep `home.` pointing at the LAN, or move `home.` to the tunnel CNAME and add a split-horizon override. Only `VH_BASE_URL` + `VH_TRUSTED_ORIGINS` + `allowedOrigins` change. Recorded as an ADR because the two-name choice has a cookie consequence (a session cookie set on one host is not sent to the other).

### 5.2 Certificate

```bash
brew install mkcert nss              # nss = trust store for Firefox
mkcert -install                      # installs the local CA into the System keychain
mkdir -p /opt/homebrew/etc/nginx/certs && cd /opt/homebrew/etc/nginx/certs
mkcert -cert-file home.machadolucas.net.crt \
       -key-file  home.machadolucas.net.key \
       home.machadolucas.net 192.168.1.50
chmod 600 home.machadolucas.net.key
openssl x509 -in home.machadolucas.net.crt -noout -dates   # confirm < 825 days
mkcert -CAROOT                       # path to rootCA.pem, needed below
```

Including the bare IP in the SAN is a deliberate escape hatch: if DNS breaks, `https://192.168.1.50/` still validates.

**iPhone trust — all three steps are required; skipping step 3 produces the classic "installed but still untrusted" dead end:**

1. **Get `rootCA.pem` onto the phone.** AirDrop it from the Mac (Files → the `mkcert -CAROOT` folder → Share → AirDrop). Do **not** email it.
2. **Install the profile.** Settings shows "Profile Downloaded" → tap → Install → passcode → Install. If missed: Settings → General → VPN & Device Management → Downloaded Profile.
3. **Enable full trust.** Settings → General → About → **Certificate Trust Settings** → toggle **mkcert <user>@<host>** on. iOS hides user-installed roots from TLS validation until this toggle is flipped.
4. Verify: Safari → `https://home.machadolucas.net/api/health` → `{"status":"ok"}` with a padlock and no interstitial.
5. Repeat 1–3 on the MacBook (`mkcert -install` covers the mini itself).

Renewal: mkcert leaves are ~2 y 3 m. Add a calendar reminder at 2 years; `doctor` warns when < 60 days remain. Re-issue = rerun `mkcert` + `nginx -s reload`; the CA (and therefore phone trust) is untouched.

### 5.3 nginx server block — `/opt/homebrew/etc/nginx/servers/virtual-home.conf`

The existing `nginx.conf` already ends with `include servers/*;` (line 352), so this file drops in without touching the shared config.

```nginx
# virtual-home — TLS terminator for the Next.js app on 127.0.0.1:3010
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name home.machadolucas.net;
    location /.well-known/acme-challenge/ { root /opt/homebrew/var/www; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name home.machadolucas.net;

    ssl_certificate     /opt/homebrew/etc/nginx/certs/home.machadolucas.net.crt;
    ssl_certificate_key /opt/homebrew/etc/nginx/certs/home.machadolucas.net.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:vh_tls:5m;
    ssl_session_timeout 1h;

    # Uploads: must exceed VH_UPLOAD_MAX_BYTES (25 MiB) + multipart overhead.
    client_max_body_size 32m;
    client_body_timeout  120s;

    access_log /opt/homebrew/var/log/nginx/virtual-home.access.log;
    error_log  /opt/homebrew/var/log/nginx/virtual-home.error.log warn;

    # HSTS is intentionally NOT set: with a private CA a bad cert would make the
    # app unreachable with no click-through. Enable only after a public cert.

    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;   # keeps Origin == Host for Next/Better Auth
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Port  $server_port;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;

        proxy_read_timeout    3600s;   # SSE streams live for hours
        proxy_send_timeout    3600s;
        proxy_connect_timeout 5s;
        proxy_buffering       off;     # without this, SSE frames sit in nginx's buffer
        proxy_request_buffering on;    # but DO buffer uploads, so slow phones don't hold Node
        proxy_cache            off;
    }

    # Immutable, fingerprinted build assets.
    location /_next/static/ {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }
}
```

Apply: `nginx -t && nginx -s reload` (add `sudo` only if nginx runs as root on the mini).

**`proxy_buffering off` is the load-bearing line.** With buffering on, nginx accumulates the SSE stream and live updates arrive in clumps — or never. `proxy_request_buffering on` is the deliberate opposite choice for uploads: let nginx absorb a slow phone's 20 MB POST and hand Node a complete body.

**How Next/Better Auth learn the external origin.** Three places, all fed from the same env:

| Consumer | Mechanism |
|---|---|
| Better Auth `baseURL` | `VH_BASE_URL` |
| Better Auth CSRF (origin check) | `trustedOrigins: () => env.trustedOrigins` |
| Next server actions | `experimental.serverActions.allowedOrigins: [new URL(VH_BASE_URL).host]` |

`proxy_set_header Host $host` means Next's own `Origin` vs `x-forwarded-host`/`host` comparison already agrees; `allowedOrigins` is belt-and-braces for the day someone changes that line. **If TLS lands on :8443 instead of :443, every one of these needs the port written out** (`home.machadolucas.net:8443`) — ports cannot be wildcarded (finding #10).

### 5.4 Documented HTTP fallback

If TLS is blocked at install time, set `VH_BASE_URL=http://192.168.1.50:3010`, `HOST=0.0.0.0`, skip nginx. `env.cookieSecure` becomes `false` automatically, so `useSecureCookies: false` and `defaultCookieAttributes.secure: false` follow with no code change. `docs/operations.md` records this as **temporary**: cleartext passwords on the LAN and no path to a PWA. `doctor` prints a warning whenever `VH_BASE_URL` is not https.

---

## 6. Supervision: launchd

### 6.1 Why launchd, not pm2

launchd is the platform's own supervisor: already running, no extra daemon to keep alive (pm2 is itself a process that needs supervising, and its resurrect/startup story on macOS is a launchd shim anyway), integrated with `log`/`newsyslog`, survives reboot via `RunAtLoad`, and gives calendar scheduling for backups for free. One less moving part to explain to an AI maintainer, and `launchctl print` is the single source of truth for job state.

**User agents vs. system daemons — the one real caveat.** `~/Library/LaunchAgents` jobs run only while the user has a session. On a headless mini, enable **automatic login** (System Settings → Users & Groups → Automatic login) so the agents start at boot, and turn off "Put hard disks to sleep"; `caffeinate` is not needed. If automatic login is unacceptable, move both plists to `/Library/LaunchDaemons`, add `<key>UserName</key><string>machadolucas</string>`, and `sudo launchctl bootstrap system /Library/LaunchDaemons/…`. The install script detects which mode is in use and reports it. Documented in `docs/operations.md`.

### 6.2 `scripts/launchd/run-web.sh`

```bash
#!/bin/bash
# Wrapper: loads secrets, rotates the launchd capture log, execs `next start`.
set -euo pipefail

APP_DIR="${VH_APP_DIR:-$HOME/git/virtual-home}"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
ENV_FILE="$DATA_DIR/secrets/vh.env"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"

# Rotate the launchd stdout/stderr capture on every start, so the current file
# always belongs to the current run. launchd has already opened the fd, so the
# rename affects the NEXT start — which is exactly the semantics we want.
for i in 3 2 1; do
  [ -f "$LOG_DIR/web.launchd.log.$i" ] && mv "$LOG_DIR/web.launchd.log.$i" "$LOG_DIR/web.launchd.log.$((i+1))" || true
done
[ -f "$LOG_DIR/web.launchd.log" ] && mv "$LOG_DIR/web.launchd.log" "$LOG_DIR/web.launchd.log.1" || true

if [ ! -f "$ENV_FILE" ]; then echo "FATAL: missing $ENV_FILE" >&2; exit 78; fi
if [ "$(stat -f '%Lp' "$ENV_FILE")" != "600" ]; then
  echo "FATAL: $ENV_FILE must be mode 600" >&2; exit 78
fi

set -a; . "$ENV_FILE"; set +a
export VH_DATA_DIR="$DATA_DIR" NODE_ENV=production
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$APP_DIR"
exec /opt/homebrew/bin/pnpm exec next start --hostname "${HOST:-127.0.0.1}" --port "${PORT:-3010}"
```

`run-worker.sh` is identical except the last line: `exec node dist/worker/index.js` (and `worker.launchd.log`).

### 6.3 Worker build

**Recommendation: `tsc` to `dist/`, not `tsx` in production.** `tsx` is excellent for dev but adds a transpile step and ~40 MB of RSS to a process meant to run for months, and a syntax error surfaces at import time under a supervisor that will restart-loop. `tsc --build tsconfig.worker.json` gives a plain `node dist/worker/index.js` — fastest startup, smallest footprint, and type errors fail the *build* step of `update.sh` before anything restarts. `esbuild` bundling is the fallback if `src/domain` import resolution gets awkward. Dev uses `tsx watch src/worker/index.ts`.

### 6.4 `~/Library/LaunchAgents/net.machadolucas.virtual-home.web.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>                 <string>net.machadolucas.virtual-home.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/machadolucas/git/virtual-home/scripts/launchd/run-web.sh</string>
  </array>
  <key>WorkingDirectory</key>      <string>/Users/machadolucas/git/virtual-home</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- Only non-secret bootstrap values. Secrets come from vh.env (0600). -->
    <key>VH_APP_DIR</key>   <string>/Users/machadolucas/git/virtual-home</string>
    <key>VH_DATA_DIR</key>  <string>/Users/machadolucas/virtual-home-data</string>
    <key>PATH</key>         <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>             <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>      <false/>
  </dict>
  <key>ThrottleInterval</key>      <integer>10</integer>
  <key>ExitTimeOut</key>           <integer>20</integer>
  <key>ProcessType</key>           <string>Interactive</string>
  <key>LowPriorityIO</key>         <false/>
  <key>StandardOutPath</key>       <string>/Users/machadolucas/virtual-home-data/logs/web.launchd.log</string>
  <key>StandardErrorPath</key>     <string>/Users/machadolucas/virtual-home-data/logs/web.launchd.log</string>
</dict>
</plist>
```

- `KeepAlive: { SuccessfulExit: false }` rather than `true`: restart on crash, but a clean `exit 0` (or our `exit 78` config failure) stays down instead of hammering. Combined with `ThrottleInterval 10` this prevents the classic "bad env var → 6 000 restarts and a 2 GB log" morning.
- `ProcessType: Interactive` + `LowPriorityIO: false` keeps macOS from applying background I/O throttling and App Nap to a latency-sensitive server. `Background` is the wrong choice here.
- `ExitTimeOut 20` gives the SSE hub time to close streams on SIGTERM.

The worker plist is the same with label `.worker`, `run-worker.sh`, and `ProcessType: Background` (it is genuinely background, and lower I/O priority is fine).

### 6.5 Backup agent — `net.machadolucas.virtual-home.backup.plist`

```xml
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string>
         <string>/Users/machadolucas/git/virtual-home/scripts/backup.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>RunAtLoad</key>  <false/>
  <key>Nice</key>       <integer>5</integer>
  <key>StandardOutPath</key>  <string>…/logs/backup.log</string>
  <key>StandardErrorPath</key><string>…/logs/backup.log</string>
```

**Nightly backups run under launchd, not the worker.** A wedged or crash-looping worker is precisely when a backup matters most; coupling the two means losing backups exactly when you need them. launchd also catches up a missed run after sleep, which an in-process cron does not.

### 6.6 `scripts/install-macmini.sh` (idempotent)

```bash
#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
ENV_FILE="$DATA_DIR/secrets/vh.env"
UID_NUM="$(id -u)"
LA="$HOME/Library/LaunchAgents"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mFATAL:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. preflight ----------
say "checking toolchain"
command -v node >/dev/null || die "node not found (brew install node@24)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || die "node 24+ required, found $(node -v)"
command -v pnpm >/dev/null || die "pnpm not found (corepack enable pnpm)"
for t in sqlite3 zstd openssl tar; do command -v "$t" >/dev/null || die "$t not found"; done
command -v sips >/dev/null || die "sips missing (expected on macOS)"

# ---------- 2. data dirs ----------
say "creating $DATA_DIR"
for d in db model attachments backups/daily backups/weekly exports secrets logs tmp; do
  mkdir -p "$DATA_DIR/$d"
done
chmod 700 "$DATA_DIR" "$DATA_DIR/secrets"

# ---------- 3. secrets ----------
if [ ! -f "$ENV_FILE" ]; then
  say "creating $ENV_FILE"
  umask 077
  cat > "$ENV_FILE" <<EOF
# virtual-home secrets and config — mode 0600, NEVER in git
NODE_ENV=production
VH_DATA_DIR=$DATA_DIR
VH_BASE_URL=https://home.machadolucas.net
VH_TRUSTED_ORIGINS=https://home.machadolucas.net
VH_HOUSEHOLD_TZ=Europe/Helsinki
VH_DELIVERY_TIME=07:30
HOST=127.0.0.1
PORT=3010
LOG_LEVEL=info
BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
HA_URL=http://192.168.1.181:8123
HA_TOKEN=REPLACE_ME
EOF
  chmod 600 "$ENV_FILE"
  say "edit $ENV_FILE and set HA_TOKEN, then re-run this script"
else
  chmod 600 "$ENV_FILE"
  grep -q '^HA_TOKEN=REPLACE_ME$' "$ENV_FILE" && die "HA_TOKEN still REPLACE_ME in $ENV_FILE"
fi
set -a; . "$ENV_FILE"; set +a

# ---------- 4. port availability ----------
if lsof -nP -iTCP:"${PORT:-3010}" -sTCP:LISTEN >/dev/null 2>&1; then
  OWNER="$(lsof -nP -iTCP:"${PORT:-3010}" -sTCP:LISTEN -F c | sed -n 's/^c//p' | head -1)"
  if [ "$OWNER" != "node" ] && [ "$OWNER" != "next-server" ]; then
    die "port ${PORT:-3010} is held by '$OWNER' — pick another PORT in $ENV_FILE"
  fi
fi

# ---------- 5. deps + build ----------
say "installing dependencies"
cd "$APP_DIR"
pnpm install --frozen-lockfile
say "building web + worker"
pnpm run build          # next build && tsc --build tsconfig.worker.json

# ---------- 6. pre-migration backup, then migrate ----------
if [ -f "$DATA_DIR/db/app.db" ]; then
  say "pre-migration backup"
  "$APP_DIR/scripts/backup.sh" --label pre-migration --keep-forever
fi
say "applying migrations"
pnpm run db:migrate

# ---------- 7. launchd ----------
say "installing launch agents"
mkdir -p "$LA"
for job in web worker backup; do
  SRC="$APP_DIR/scripts/launchd/net.machadolucas.virtual-home.$job.plist"
  DST="$LA/net.machadolucas.virtual-home.$job.plist"
  sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__DATA_DIR__|$DATA_DIR|g" -e "s|__HOME__|$HOME|g" \
      "$SRC" > "$DST"
  plutil -lint "$DST" >/dev/null || die "invalid plist: $DST"
  launchctl bootout "gui/$UID_NUM/net.machadolucas.virtual-home.$job" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$DST"
  launchctl enable "gui/$UID_NUM/net.machadolucas.virtual-home.$job"
done

# ---------- 8. users ----------
if [ "$(sqlite3 "$DATA_DIR/db/app.db" 'SELECT count(*) FROM user;' 2>/dev/null || echo 0)" = "0" ]; then
  say "no users yet — run:  pnpm vh-admin init-users"
fi

# ---------- 9. verify ----------
say "waiting for health check"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT:-3010}/api/health" >/dev/null 2>&1; then
    say "web is healthy on 127.0.0.1:${PORT:-3010}"; break
  fi
  [ "$i" = 30 ] && die "web did not become healthy; see $DATA_DIR/logs/web.launchd.log"
  sleep 1
done
launchctl print "gui/$UID_NUM/net.machadolucas.virtual-home.worker" | grep -E 'state|last exit' || true
say "done. nginx: cp scripts/nginx/virtual-home.conf /opt/homebrew/etc/nginx/servers/ && nginx -t && nginx -s reload"
```

Idempotency: every step is create-if-absent or replace-in-place; `bootout || true` then `bootstrap` is the reliable reload idiom (`launchctl load -w` is deprecated and silently no-ops on an already-loaded label).

### 6.7 `scripts/update.sh`

Ordering is chosen so the web process never serves a build whose schema the DB lacks, **and** so `next build` never overwrites `.next` under a running server (which causes chunk 404s and cryptic hydration errors).

```bash
#!/bin/bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
UID_NUM="$(id -u)"; cd "$APP_DIR"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

[ -z "$(git status --porcelain)" ] || { echo "working tree dirty; commit or stash" >&2; exit 1; }

say "1/8 backup (rollback point)"
./scripts/backup.sh --label pre-update --keep-forever
BEFORE="$(git rev-parse --short HEAD)"

say "2/8 git pull"
git pull --ff-only

say "3/8 install"
pnpm install --frozen-lockfile

say "4/8 typecheck + tests (fail before touching anything live)"
pnpm run typecheck && pnpm run test:unit

# Stop BEFORE build: `next build` rewrites .next in place.
say "5/8 stop worker, then web"
launchctl kill SIGTERM "gui/$UID_NUM/net.machadolucas.virtual-home.worker" 2>/dev/null || true
launchctl kill SIGTERM "gui/$UID_NUM/net.machadolucas.virtual-home.web"    2>/dev/null || true
sleep 3

say "6/8 migrate"
if ! pnpm run db:migrate; then
  echo "MIGRATION FAILED. DB untouched or partially migrated." >&2
  echo "Restore with: ./scripts/restore.sh $DATA_DIR/backups/daily/<pre-update>.tar.zst" >&2
  echo "Then: git checkout $BEFORE && ./scripts/install-macmini.sh" >&2
  exit 1
fi

say "7/8 build"
pnpm run build

say "8/8 start web, then worker"
launchctl kickstart -k "gui/$UID_NUM/net.machadolucas.virtual-home.web"
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT:-3010}/api/health" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "web unhealthy after update" >&2; exit 1; }; sleep 1
done
launchctl kickstart -k "gui/$UID_NUM/net.machadolucas.virtual-home.worker"
say "updated $BEFORE -> $(git rev-parse --short HEAD)"
```

Worker stops **first** (it writes to the DB; migrating under an active writer risks `SQLITE_BUSY` and half-applied DDL) and starts **last** (so the web process is already healthy and the schema is current). Downtime is ~60–90 s, which is fine for two people. Zero-downtime via `distDir` blue/green is noted in `docs/operations.md` as a deliberate non-goal.

Migrations are **forward-only, additive-first**: never `DROP COLUMN` in the same release that stops writing it. Two-phase (release N stops writing; release N+1 drops) keeps the pre-update backup restorable against release N code.

---

## 7. Worker ↔ web communication and SSE

### 7.1 Decision: SQLite outbox + 1 s poll (option a)

| Option | Assessment |
|---|---|
| **(a) SQLite outbox + counter poll** | ✅ **Chosen.** |
| (b) Local IPC (Unix socket / localhost POST + shared secret) | Lower latency (~5 ms vs ~500 ms avg) but adds: a second listening surface, a shared secret to manage, retry/queue logic in the worker for when web is restarting, ordering guarantees to hand-roll, and a *silent* failure mode (worker POSTs into the void, UI just stops updating). Doesn't solve `Last-Event-ID` replay — you'd need the DB anyway. |
| (c) Both processes connect to HA | Two WebSockets, two `get_states` snapshots, double token exposure (now the web process holds `HA_TOKEN` in memory, contradicting the security goal), and two divergent caches. Rejected. |

Why (a) wins for this system specifically:

- **Cost is negligible and measurable.** One `SELECT seq FROM event_cursor WHERE id = 1` per second against a hot single-row page: microseconds of CPU, no disk I/O after the first read (page stays in cache). It's one timer in one process — *not* per-connected-client. A household's real event rate is a handful per minute; polling a counter 86 400 times/day costs far less than maintaining an IPC channel.
- **Restart-order independence.** Either process can restart at any moment in any order with zero coordination. With (b), a worker→web POST during a web restart is simply lost.
- **The DB is already the source of truth**, so `Last-Event-ID` replay, the `/settings/system` page, and cold page loads all read the same rows. No dual-write consistency problem.
- **Simplicity for AI-maintained code** — the brief's explicit criterion. The whole mechanism is two tables and a `setInterval`. There is no secret, no port, no framing, no reconnect logic between processes. A future maintainer can understand it from the schema alone, and `sqlite3 app.db 'SELECT * FROM event_outbox ORDER BY id DESC LIMIT 20'` debugs it completely.
- **Latency is fine.** Average 500 ms, worst 1 s, from a physical light switch to a browser dot changing colour. Imperceptible for the actual use case.

Escape hatch, documented not built: if a sub-100 ms interaction ever appears, add an optional `POST /api/internal/nudge` (shared secret from `vh.env`, loopback-only) that just wakes the poll loop early. The outbox stays the transport, so the nudge is pure latency optimization and its failure degrades to 1 s polling rather than breaking anything.

### 7.2 Schema

```ts
// src/db/schema/events.ts
export const eventOutbox = sqliteTable('event_outbox', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  topic:     text('topic').notNull(),          // 'ha.state' | 'task.changed' | 'integration.status' | …
  entityKey: text('entity_key'),               // coalescing key, e.g. 'light.kitchen'
  payload:   text('payload', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [index('event_outbox_created_idx').on(t.createdAt)]);

// Single row. Written in the SAME transaction as the insert, so readers never
// see a bumped counter without the rows, and it survives retention deletes
// (MAX(id) would return NULL on an emptied table).
export const eventCursor = sqliteTable('event_cursor', {
  id:  integer('id').primaryKey(),             // always 1
  seq: integer('seq').notNull(),
});
```

`src/server/events/outbox.ts` — the only writer API, used by both processes:

```ts
const stmtInsert = db.insert(eventOutbox);
export const publish = db.transaction((items: OutboxItem[]) => {
  for (const it of items) {
    stmtInsert.values({ ...it, createdAt: new Date() }).run();
  }
  db.update(eventCursor)
    .set({ seq: sql`(SELECT COALESCE(MAX(id), 0) FROM event_outbox)` })
    .where(eq(eventCursor.id, 1)).run();
});
// Call sites use publish.immediate(items) — see §7.6 on BEGIN IMMEDIATE.
```

### 7.3 Coalescing — two stages

**Stage 1, worker-side (pre-write).** HA emits every `state_changed` on the instance. The worker filters to linked entities, then buffers into a `Map<entityKey, payload>` and flushes on a 250 ms timer. Last-write-wins per entity. A dimmer swept through 40 values becomes one row. Attribute-only changes where `state` is unchanged and no *linked* attribute differs are dropped entirely before buffering. This is the important stage — it keeps the DB from growing at HA's event rate.

**Stage 2, web-side (pre-send).** The hub coalesces per `(topic, entityKey)` across a flush window and sends at most one frame per client per 500 ms. A client that reconnects mid-burst gets the collapsed tail, not the history.

### 7.4 Message shape

One SSE frame carries a batch, so the `id:` field is the batch's max seq and `Last-Event-ID` resume is exact.

```
retry: 3000

event: batch
id: 10432
data: {"seq":10432,"items":[
data:   {"seq":10429,"topic":"ha.state","key":"light.kitchen","at":1757300000000,
data:    "payload":{"state":"on","attrs":{"brightness":180}}},
data:   {"seq":10432,"topic":"integration.status","key":"ha",
data:    "payload":{"state":"connected"}}]}

: keep-alive 1757300015000
```

Control frames:

- `event: hello` → `{"seq":10432,"serverStartedAt":…}` on connect, so the client knows its baseline without a round-trip.
- `event: resync` → `{"seq":10500,"reason":"gap"}` when the requested `Last-Event-ID` predates the oldest retained row, or when a client is dropped for backpressure. The client refetches via `router.refresh()` and adopts the new seq.
- `:` comment keep-alive every 15 s — beats nginx's `proxy_read_timeout 3600s` and any NAT idle timer, and lets the server notice dead sockets.

### 7.5 `app/api/events/route.ts`

```ts
export const dynamic = 'force-dynamic';

export const GET = authed(async (session, req) => {
  const hub = getHub();
  if (hub.size >= env.VH_SSE_MAX_CLIENTS) {
    return new Response('too many streams', { status: 503, headers: { 'Retry-After': '5' } });
  }
  const lastEventId = Number(req.headers.get('last-event-id') ?? '0') || 0;
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const client = hub.add({
        userId: session.user.id,
        lastSeq: lastEventId,
        write: (chunk: string) => {
          controller.enqueue(enc.encode(chunk));
          // Negative desiredSize => the consumer is not draining.
          return (controller.desiredSize ?? 1) > 0;
        },
        close: () => { try { controller.close(); } catch {} },
      });
      req.signal.addEventListener('abort', () => hub.remove(client));
    },
    cancel() { hub.removeByStream(this as never); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',       // belt-and-braces with proxy_buffering off
    },
  });
});
```

### 7.6 Hub (`src/server/events/hub.ts`)

A `globalThis` singleton so Next's module graph (and dev HMR) can't create two pollers:

```ts
const KEY = Symbol.for('virtual-home.event-hub');
export function getHub(): Hub { return (globalThis as any)[KEY] ??= new Hub(); }
```

- **Lifecycle:** the 1 s `setInterval` starts on the first subscriber and stops 30 s after the last one leaves. An idle app costs zero timers. `unref()` the timer so it never holds the process open during shutdown.
- **Poll:** read `event_cursor.seq`. If unchanged (the overwhelming majority of ticks), do nothing — no second query. If it advanced, `SELECT * FROM event_outbox WHERE id > :minClientSeq ORDER BY id`, coalesce, and fan out per client from its own `lastSeq`.
- **Backpressure:** if `write()` returns false, increment `client.stalled`. At 3 consecutive stalled flushes, stop sending deltas and queue a single `resync`; at 5, close the stream (the browser's `EventSource` reconnects automatically and gets a `hello` with the current seq). A slow phone on bad Wi-Fi degrades to "refresh on reconnect" instead of ballooning server memory. Per-flush payload is capped at 64 KiB; over that, send `resync` instead of the batch.
- **Retention:** the worker deletes `event_outbox` rows older than 10 minutes once a minute. `hub` tracks `oldestRetainedSeq` to decide `resync` vs. replay.
- **Shutdown:** on `SIGTERM`, send `event: bye`, close all streams, clear the timer — so `ExitTimeOut 20` is never hit.

**SQLite settings for two writers** (`src/db/client.ts`):

```ts
const sqlite = new Database(env.dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('wal_autocheckpoint = 1000');
```

**Every write transaction must use `BEGIN IMMEDIATE`** — with better-sqlite3 that is `myTxn.immediate(args)`, not `myTxn(args)`. A deferred transaction that starts reading and later upgrades to a write can deadlock against the other process's writer, and `busy_timeout` cannot rescue it (SQLite returns `SQLITE_BUSY_SNAPSHOT` immediately rather than waiting). This one detail is the difference between "rock solid for years" and "mysterious errors under concurrent load", so it belongs in `CLAUDE.md` as a hard rule with a lint note.

### 7.7 Client

```ts
// Native EventSource handles reconnection and Last-Event-ID automatically.
const es = new EventSource('/api/events');   // same-origin, cookie sent
es.addEventListener('batch',  e => applyBatch(JSON.parse(e.data)));
es.addEventListener('resync', () => router.refresh());
es.addEventListener('hello',  e => setBaseline(JSON.parse(e.data).seq));
```

`EventSource` re-sends `Last-Event-ID` and honours `retry:` with its own backoff. When the cookie has expired the reconnect gets a 401; the client detects `es.readyState === CLOSED` plus a 401 and does a full navigation to `/login`. Add a `visibilitychange` handler that closes the stream when the tab is hidden > 5 minutes and reopens on focus — meaningful battery saving on iPhones.

---

## 8. HA transport

### 8.1 Ownership

The **worker alone** holds `HA_TOKEN` and the WebSocket. The web process reads HA state from SQLite and, for on-demand history only, calls HA REST server-side (§8.6). The token is never in a client bundle, never in a `NEXT_PUBLIC_*` var, never in an SSR payload. Enforced by a CI grep over `.next/static/**` for the token's first 8 characters at deploy time — cheap and catches the catastrophic mistake.

### 8.2 State machine (`src/worker/ha/socket.ts`)

```
        ┌──────────────┐
        │ disconnected │◄──────────────────────────────┐
        └──────┬───────┘                               │
               │ connect()                             │
        ┌──────▼───────┐   ws error/close              │
        │  connecting  ├───────────────────────────────►│
        └──────┬───────┘                               │
               │ auth_required                         │
        ┌──────▼────────────┐  auth_invalid            │
        │  authenticating   ├──────────► fatal ────────┤ (long backoff + loud log)
        └──────┬────────────┘                          │
               │ auth_ok                               │
        ┌──────▼───────┐                               │
        │  syncing     │  get_states + 4x registry list│
        └──────┬───────┘                               │
               │ snapshot persisted                    │
        ┌──────▼───────┐  missed pong / close          │
        │  subscribed  ├───────────────────────────────┤
        └──────┬───────┘                               │
               │ >2 missed pongs                       │
        ┌──────▼────────┐                              │
        │  degraded     ├──────────────────────────────┘
        └───────────────┘
```

Transitions in detail:

- **connecting** → `new WebSocket(env.haWs)` with a 10 s handshake timeout.
- **authenticating** → on `{"type":"auth_required"}` send `{"type":"auth","access_token":HA_TOKEN}`. On `auth_ok` capture `ha_version`. On **`auth_invalid`** do *not* fast-retry: this is a bad/revoked token, and hammering it just fills HA's log. Jump to a 5-minute floor backoff, write `integration_status.state='auth_failed'` with `lastError='invalid token'`, and log at `error` so `/settings/system` shows a red banner with the fix ("rotate HA_TOKEN, see operations.md").
- **syncing** → issue, in parallel, `get_states`, `config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list`, `config/floor_registry/list`. Persist as one `BEGIN IMMEDIATE` transaction so the web never sees a half-updated registry. Then `subscribe_events`.
- **subscribed** → steady state. Publish coalesced deltas to the outbox (§7.3).
- **degraded** → connection believed dead; terminate the socket (`ws.terminate()`, not `close()` — a half-open TCP socket will otherwise hang for minutes) and re-enter backoff.

Message ids: a monotonically increasing counter **per connection**, starting at 1, reset on every reconnect. Pending commands live in a `Map<id, {resolve, reject, timer}>` with a 30 s timeout; on disconnect every pending promise rejects with `HaDisconnected` so no caller hangs forever.

### 8.3 Backoff and heartbeat

```ts
// Full-jitter exponential backoff. Jitter matters: without it, an HA restart
// makes the worker retry in a tight, perfectly-aligned rhythm.
const base = 1000, cap = 60_000;
const delay = Math.random() * Math.min(cap, base * 2 ** Math.min(attempt, 6));
// auth_invalid overrides: delay = max(delay, 300_000)
```

Heartbeat: every 30 s send `{"id":n,"type":"ping"}` and expect `{"id":n,"type":"pong"}` within 10 s. Two consecutive misses → `degraded`. This is essential, not optional: a Wi-Fi/router hiccup leaves a TCP socket that looks open and delivers nothing, and without a ping the worker would sit "connected" and silently stale for hours. Also enable `ws` protocol-level `WebSocket({ ... })` pings as a second line of defence.

**Re-subscribe after every reconnect.** Subscription ids do not survive a new socket. The reconnect path always goes through `syncing` — a fresh `get_states` snapshot — because state changed while we were away and `state_changed` events only tell us about the future. Skipping the re-snapshot is the classic "the app shows yesterday's state after a network blip" bug.

### 8.4 Registry refresh — event-driven, no polling

Subscribe to `entity_registry_updated`, `device_registry_updated`, `area_registry_updated`, `floor_registry_updated`. On any of them, **debounce 2 s and re-run the corresponding `config/*/list`**, replacing the local table wholesale.

Do **not** apply the event's `changes` payload — finding #8: `entity_registry_updated` reports *old* values under `changes` (core issues #134613, #152288). The HA frontend itself responds to this event with a full list refresh, and matching that behaviour is the only correct approach. Treat these events strictly as cache-invalidation signals. This is worth a comment in the code, because the payload looks temptingly usable.

Device registry parsing must tolerate the 2026.8–2026.9 changes (finding #9): prefer `config_entry_id` / `config_subentry_id` over the deprecated `config_entries`, and accept **child devices** that carry `parent_device_id` and lack hardware/firmware fields. Parse with a lenient zod schema (`.passthrough()`, optional hardware fields) so an HA upgrade adding fields never crashes the worker.

### 8.5 Subscription strategy

v1 uses `subscribe_events` with `event_type: "state_changed"` and client-side filtering against the linked-entity set, per the brief. HA sends every state change on the instance, so this costs one JSON parse per event — fine at household scale.

Documented upgrade path if CPU ever shows up in the metrics: switch to **`subscribe_trigger`** with a state trigger enumerating the linked `entity_id`s, which filters server-side in HA and eliminates the parse entirely. (`subscribe_trigger` is confirmed present in the WS API alongside `subscribe_events`.) The tradeoff is that the subscription must be torn down and re-established whenever the linked set changes, which is why it isn't the default. `subscribe_entities` (compressed diffs) is a third option but its payload format is less stable and undocumented.

Also subscribe to **`mobile_app_notification_action`** to receive action-button taps from notifications. Handler: match `event.data.action` against a pending-action table (with a nonce and a TTL), apply the domain effect, publish to the outbox. Never trust `event.data` beyond the nonce lookup — it originates outside the app.

### 8.6 Outbound service calls and REST

Notifications: `call_service` with `domain: "notify"`, `service: "mobile_app_<device_slug>"`, `service_data: { title, message, data: { url, actions, tag, group } }`. Per-user device slugs live in the DB (`household_member.notifyService`), not env, so adding a phone doesn't require a restart. `url` deep-links into `VH_BASE_URL` — which is why `sameSite: 'lax'` is mandatory (§3.1). Set `tag` for replace-in-place and `group` for stacking.

Delivery is retried with the same backoff as the socket; a failed notify writes a `notification_log` row with the error so `/settings/system` can show "3 notifications failed to deliver".

REST is used **only** for on-demand history, via `app/api/ha/history/route.ts`:

```ts
export const GET = authed(async (_session, req) => {
  if (!env.VH_HA_HISTORY_ENABLED) return Response.json({ error: 'disabled' }, { status: 503 });
  const q = HistoryQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
  // entityId must be in the linked-entity allowlist — never proxy arbitrary entities.
  if (!(await isLinkedEntity(q.entityId))) return Response.json({ error: 'not_linked' }, { status: 404 });

  const url = new URL(`/api/history/period/${q.start}`, env.HA_URL);
  url.searchParams.set('filter_entity_id', q.entityId);
  url.searchParams.set('end_time', q.end);
  url.searchParams.set('minimal_response', 'true');
  url.searchParams.set('no_attributes', 'true');

  const r = await fetch(url, {
    headers: { authorization: `Bearer ${env.HA_TOKEN!}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) { log.warn({ status: r.status, entityId: q.entityId }, 'ha history failed');
               return Response.json({ error: 'upstream' }, { status: 502 }); }
  return Response.json(await r.json(), { headers: { 'Cache-Control': 'private, max-age=60' } });
});
```

The **entity allowlist is the important control**: without it this route is an open proxy letting any logged-in user read any entity's history from HA, including cameras and device trackers. `minimal_response` + `no_attributes` keep payloads small. `HA_TOKEN` is therefore present in the web process too — a conscious narrowing of the original "worker only" goal, justified because history is inherently request-scoped; `VH_HA_HISTORY_ENABLED=false` removes it entirely if that trade is unwanted. Recorded as an ADR.

### 8.7 Status for both processes

```ts
export const integrationStatus = sqliteTable('integration_status', {
  id:             text('id').primaryKey(),      // 'ha'
  state:          text('state').notNull(),      // connecting|authenticating|syncing|subscribed|degraded|auth_failed|disconnected
  haVersion:      text('ha_version'),
  lastOkAt:       integer('last_ok_at',    { mode: 'timestamp_ms' }),
  heartbeatAt:    integer('heartbeat_at',  { mode: 'timestamp_ms' }).notNull(),
  lastError:      text('last_error'),           // redacted, never contains the token
  reconnectCount: integer('reconnect_count').notNull().default(0),
  entityCount:    integer('entity_count').notNull().default(0),
  updatedAt:      integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
```

The worker updates `heartbeatAt` every `VH_WORKER_HEARTBEAT_MS` (15 s) regardless of HA state — that separates "worker is alive" from "HA is reachable". The web derives worker liveness as `now - heartbeatAt < 3 × 15 s`; a stale heartbeat means *the worker* is down, and the UI must say so distinctly ("Background service not running") rather than blaming HA. State transitions also publish an `integration.status` outbox event so open tabs update instantly.

---

## 9. Files, uploads, and model serving

### 9.1 Layout under `VH_DATA_DIR` (mode `700`)

```
db/app.db{,-wal,-shm}
model/<fingerprint>/{model.json,*.glb}       # content-addressed by fingerprint
attachments/<yyyy>/<mm>/<id>.<ext>           # original
attachments/<yyyy>/<mm>/<id>.web.jpg         # ≤2048px
attachments/<yyyy>/<mm>/<id>.thumb.jpg       # ≤400px
tmp/                                          # upload staging, same filesystem
backups/{daily,weekly}/
exports/
secrets/vh.env                                # 600
logs/
```

`tmp/` on the same filesystem is what makes `fs.rename` atomic — a file becomes visible at its final path only when fully written and hashed. Nothing in `public/`; a CI check fails the build if `public/` contains anything but committed app chrome (`grep`-based deny-list on extensions).

### 9.2 Metadata

```ts
export const attachment = sqliteTable('attachment', {
  id:          text('id').primaryKey(),            // uuidv7 — sorts by time
  kind:        text('kind').notNull(),             // 'photo' | 'document'
  origName:    text('orig_name').notNull(),
  mime:        text('mime').notNull(),             // sniffed, not client-declared
  bytes:       integer('bytes').notNull(),
  sha256:      text('sha256').notNull(),
  width:       integer('width'),
  height:      integer('height'),
  hasWebCopy:  integer('has_web_copy', { mode: 'boolean' }).notNull().default(false),
  path:        text('path').notNull(),             // relative to attachDir
  uploadedBy:  text('uploaded_by').notNull().references(() => user.id),
  createdAt:   integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  index('attachment_sha_idx').on(t.sha256),        // dedupe
  index('attachment_created_idx').on(t.createdAt),
]);
```

`sha256` gives free dedupe (re-uploading the same manual reuses the blob) and lets the backup test verify byte-identity after restore.

### 9.3 Upload pipeline (`app/api/upload/route.ts`)

1. `requireSession()`.
2. Read the multipart stream to `tmp/<uuid>.part`, **counting bytes and aborting past `VH_UPLOAD_MAX_BYTES`**. Never buffer the whole file in memory. `Content-Length` is a hint, not a limit — enforce on the actual stream.
3. **Sniff the real type from magic bytes**, ignoring the client's `Content-Type` and the filename entirely.
4. Reject anything not on the allowlist.
5. Hash while streaming (`crypto.createHash('sha256')`).
6. Derive web copy + thumbnail (images) via the strategy below.
7. `fs.rename` into `attachments/<yyyy>/<mm>/`, insert the DB row, publish an outbox event. On any failure, unlink temp files.

`src/server/files/sniff.ts` — a small hand-rolled sniffer rather than a dependency, since the allowlist is six types and this code must stay auditable:

| Type | Magic |
|---|---|
| JPEG | `FF D8 FF` |
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| WebP | `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` (`RIFF….WEBP`) |
| HEIC/HEIF | `?? ?? ?? ?? 66 74 79 70` at 4 (`ftyp`) + brand ∈ `heic heix hevc hevx mif1 msf1 heim heis` |
| AVIF | same `ftyp` with brand `avif`/`avis` |
| PDF | `25 50 44 46 2D` (`%PDF-`) |

Read 4 100 bytes (enough for `ftyp` brand lists). PDFs get one extra check: reject if the first 4 KiB contain `/JavaScript`, `/JS`, or `/OpenAction` — cheap, no false positives on real manuals, and it keeps hostile PDFs out of storage. Anything else → 415 with a plain-language message.

### 9.4 HEIC — the real plan (finding #2)

sharp's prebuilt binary **cannot decode HEIC**. Three layers, in order:

1. **Prevention (primary).** The file input declares `accept="image/jpeg,image/png,image/webp"` (no `image/*`, no `image/heic`). iOS Safari transcodes HEIC to JPEG on the client when the accept list excludes HEIC — so the overwhelmingly common path never produces a HEIC at all. `<input type="file" accept="…" capture="environment">` for the camera path: `capture` needs no Permissions-Policy grant and no `getUserMedia` prompt.
2. **Server fallback via `sips`** (verified present at `/usr/bin/sips`, `public.heic … Writable`, `public.heif`, `public.avif`, `public.jpeg-xl` all listed). If a HEIC arrives anyway (Android, a share sheet, a desktop drag):

   ```bash
   /usr/bin/sips -s format jpeg -s formatOptions 90 "$IN" --out "$OUT"
   ```

   Wrapped with `execFile` (never a shell), a 20 s timeout, and an output-size sanity check. The JPEG then goes through the normal sharp pipeline. Zero new dependencies and it uses the OS's own well-maintained HEIF stack.
3. **Capability probe at boot**, so behaviour is known rather than discovered in production:

   ```ts
   export const heifViaSharp = Boolean(sharp.format.heif?.input?.file);
   export const heifViaSips  = existsSync('/usr/bin/sips');
   // logged once at startup; surfaced on /settings/system
   ```

   If neither is available, uploads of HEIC are rejected with an actionable message ("Your phone sent a HEIC file. Set Settings → Camera → Formats → Most Compatible, or upload a JPEG.") rather than a 500.

### 9.5 Derivatives and EXIF

```ts
const pipeline = sharp(input, { failOn: 'error', limitInputPixels: 268_402_689 /* 16k² */ })
  .rotate();                                   // bake in EXIF orientation before stripping
const web   = pipeline.clone().resize({ width: 2048, height: 2048, fit: 'inside',
                                        withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true });
const thumb = pipeline.clone().resize({ width: 400,  height: 400,  fit: 'inside',
                                        withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true });
```

sharp drops all metadata unless `withMetadata()` is called, so **derivatives are EXIF-free by construction** — including GPS. `.rotate()` before resize is mandatory; strip orientation without applying it and every portrait photo appears sideways. `limitInputPixels` blocks decompression bombs.

**The stored original** keeps full fidelity but must lose GPS. `exiftool` is available (`/opt/homebrew/bin/exiftool`), so:

```bash
exiftool -overwrite_original -gps:all= -geotag= "$FILE"
```

This edits metadata only — image data is untouched, no re-encode, no generation loss. It runs on JPEG/HEIC/PNG/WebP alike. Since it's a Homebrew dependency and not guaranteed, the design degrades: if `exiftool` is absent, fall back to a built-in JPEG APP-segment stripper (walk markers, drop `APP1`/`APP13`, keep `APP0` JFIF and `APP2` ICC — lossless, ~40 lines) for JPEG, and for other formats store the original as-is with `attachment.hasPrivateMetadata = true` flagged in the UI. Rationale for accepting that residual case: originals are served only to two authenticated household members over TLS, so the exposure is a household member seeing a household GPS coordinate. Recorded as an ADR with the residual risk stated rather than hand-waved.

### 9.6 Serving files

```ts
// app/api/attachments/[id]/route.ts   (Next 16: params is async)
export const GET = authed(async (_s, req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const row = db.select().from(attachment).where(eq(attachment.id, id)).get();
  if (!row) return new Response('not found', { status: 404 });

  const variant = new URL(req.url).searchParams.get('v');   // 'web' | 'thumb' | null
  const abs = resolveVariant(row, variant);                 // path-guarded, see below
  const st  = await stat(abs);
  const etag = `"${row.sha256.slice(0, 32)}-${variant ?? 'orig'}"`;

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }

  const range = req.headers.get('range');
  if (range && row.mime === 'application/pdf') {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end   = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      }
      return new Response(Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': row.mime,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          ETag: etag,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Content-Disposition': disposition(row),
        },
      });
    }
  }

  return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(st.size),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': disposition(row),
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
```

Key points:

- **`private` (never `public`)** on every attachment response — with `immutable` and a long max-age, because the URL is content-addressed via the sha-derived ETag and the bytes never change for a given id+variant.
- `Content-Disposition`: `inline` for `image/*` and `application/pdf` (so PDFs open in the iOS viewer), `attachment; filename*=UTF-8''…` for everything else. Always RFC 5987-encode — Finnish filenames with `ä`/`ö` break naive quoting.
- **Range support is implemented for PDFs specifically**, because iOS/Safari's PDF viewer issues range requests for large manuals and a 200-only server makes it download the whole file before showing page 1.
- `disposition()` never echoes the client-supplied `origName` without sanitising CR/LF (header injection).

### 9.7 Model serving

```ts
// app/api/model/[...path]/route.ts
export const GET = authed(async (_s, req, { params }: { params: Promise<{ path: string[] }> }) => {
  const { path: segs } = await params;
  const fp = new URL(req.url).searchParams.get('v');
  if (!fp || !/^[a-f0-9]{12,64}$/.test(fp)) return new Response('missing fingerprint', { status: 400 });
  if (fp !== (await currentFingerprint())) return new Response('stale model', { status: 409 });

  const abs = safeJoin(env.modelDir, fp, segs);       // throws on traversal
  if (!abs) return new Response('not found', { status: 404 });
  // …stream with Cache-Control: private, max-age=31536000, immutable
});
```

`safeJoin` is the security core and gets its own unit tests:

```ts
export function safeJoin(root: string, ...segs: string[]): string | null {
  if (segs.some(s => s.includes('\0') || s === '..' || s.includes('/') || s.includes('\\'))) return null;
  const abs = path.resolve(root, ...segs);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;              // rejects symlinks and dirs
  if (!ALLOWED_EXT.has(path.extname(abs).toLowerCase())) return null;  // .json .glb .bin .ktx2
  return abs;
}
```

`lstat` (not `stat`) is what rejects a symlink pointing at `~/.ssh/id_ed25519`. Test cases: `..`, `..%2f`, `....//`, absolute paths, NUL bytes, a planted symlink, a directory, an unlisted extension, unicode normalisation tricks.

Fingerprint: `sha256` over `model.json` bytes plus each GLB's sha256 in sorted filename order, truncated to 16 hex chars, stored in a `model_version` table and recomputed by the worker at boot and on `fs.watch` of `model/`. Because it's in the path *and* the query, a new model package gets entirely new URLs, so `immutable` caching is safe and clients can't mix assets across versions — the 409 on a stale fingerprint tells the client to reload rather than silently render a half-old scene.

---

## 10. Backup and restore

### 10.1 `scripts/backup.sh`

```bash
#!/bin/bash
# Consistent snapshot of db + attachments + model + redacted config.
set -euo pipefail

DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="nightly"; KEEP_FOREVER=0
while [ $# -gt 0 ]; do case "$1" in
  --label) LABEL="$2"; shift 2;;
  --keep-forever) KEEP_FOREVER=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done

TS="$(date +%Y%m%d-%H%M%S)"
NAME="vh-${TS}-${LABEL}"
STAGE="$DATA_DIR/tmp/$NAME"
OUT_DIR="$DATA_DIR/backups/daily"
OUT="$OUT_DIR/$NAME.tar.zst"
mkdir -p "$STAGE" "$OUT_DIR" "$DATA_DIR/backups/weekly"
trap 'rm -rf "$STAGE"' EXIT

# --- 1. SQLite: .backup is WAL-safe and consistent with live writers ---
/usr/bin/sqlite3 "$DATA_DIR/db/app.db" ".backup '$STAGE/app.db'"
/usr/bin/sqlite3 "$STAGE/app.db" 'PRAGMA integrity_check;' | head -1 | grep -qx ok \
  || { echo "FATAL: snapshot failed integrity_check" >&2; exit 1; }
SCHEMA_VERSION="$(/usr/bin/sqlite3 "$STAGE/app.db" \
  'SELECT COALESCE(MAX(hash),"none") FROM __drizzle_migrations;' 2>/dev/null || echo none)"
ROWS="$(/usr/bin/sqlite3 -json "$STAGE/app.db" "
  SELECT (SELECT count(*) FROM user) AS users,
         (SELECT count(*) FROM attachment) AS attachments;")"

# --- 2. payload ---
cp -R "$DATA_DIR/attachments" "$STAGE/attachments"
cp -R "$DATA_DIR/model"       "$STAGE/model"

# --- 3. config WITHOUT secrets ---
sed -E 's/^(BETTER_AUTH_SECRET|HA_TOKEN)=.*/\1=<REDACTED>/' \
    "$DATA_DIR/secrets/vh.env" > "$STAGE/vh.env.redacted"
cat > "$STAGE/SECRETS-README.txt" <<'EOF'
BETTER_AUTH_SECRET and HA_TOKEN are deliberately NOT in this archive.
Restoring without them: generate a new BETTER_AUTH_SECRET (all sessions are
invalidated; sign in again) and mint a new HA long-lived token.
Keep the real values in your password manager, not here.
EOF

# --- 4. manifest ---
cat > "$STAGE/manifest.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "label": "$LABEL",
  "appVersion": "$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)",
  "gitCommit": "$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "schemaVersion": "$SCHEMA_VERSION",
  "modelFingerprint": "$(cat "$DATA_DIR/model/.fingerprint" 2>/dev/null || echo unknown)",
  "sqliteVersion": "$(/usr/bin/sqlite3 --version | awk '{print $1}')",
  "host": "$(scutil --get LocalHostName 2>/dev/null || hostname)",
  "rowCounts": $ROWS,
  "excludes": ["BETTER_AUTH_SECRET", "HA_TOKEN", "logs/", "backups/", "tmp/", "exports/"]
}
EOF

# --- 5. archive: PIPE through zstd. `tar --zstd` on this bsdtar exits 0 but
#     barely compresses (measured 10240 vs 308 bytes on a test payload).
/usr/bin/tar -cf - -C "$DATA_DIR/tmp" "$NAME" | /opt/homebrew/bin/zstd -19 -T0 -q -o "$OUT"
chmod 600 "$OUT"
shasum -a 256 "$OUT" | awk '{print $1}' > "$OUT.sha256"

# --- 6. verify the archive is readable before trusting it ---
/opt/homebrew/bin/zstd -dc "$OUT" | /usr/bin/tar -tf - >/dev/null \
  || { echo "FATAL: archive unreadable" >&2; rm -f "$OUT" "$OUT.sha256"; exit 1; }

# --- 7. weekly promotion (hardlink: no extra space) ---
[ "$(date +%u)" = "7" ] && ln -f "$OUT" "$DATA_DIR/backups/weekly/$NAME.tar.zst" || true

# --- 8. retention ---
if [ "$KEEP_FOREVER" = "0" ]; then
  ls -1t "$OUT_DIR"/vh-*-nightly.tar.zst 2>/dev/null | tail -n +$((${VH_BACKUP_RETAIN_DAILY:-14}+1)) \
    | while read -r f; do rm -f "$f" "$f.sha256"; done
  ls -1t "$DATA_DIR/backups/weekly"/vh-*.tar.zst 2>/dev/null | tail -n +$((${VH_BACKUP_RETAIN_WEEKLY:-8}+1)) \
    | while read -r f; do rm -f "$f" "$f.sha256"; done
fi

/usr/bin/sqlite3 "$DATA_DIR/db/app.db" \
  "INSERT INTO backup_run (id, created_at, label, path, bytes, ok)
   VALUES (lower(hex(randomblob(16))), $(date +%s000), '$LABEL', '$OUT', $(stat -f%z "$OUT"), 1);"
echo "backup ok: $OUT ($(du -h "$OUT" | awk '{print $1}'))"
```

`sqlite3 .backup` uses SQLite's online backup API: consistent under WAL with live writers, no `VACUUM INTO` locking, no need to stop the app. `--keep-forever` marks pre-migration and pre-update snapshots so retention can't delete the one you need for a rollback. Recording the run in the DB is what makes "last backup" showable on `/settings/system` — and a *missing* row is the alert.

### 10.2 `scripts/restore.sh`

```bash
#!/bin/bash
set -euo pipefail
ARCHIVE="${1:?usage: restore.sh <archive.tar.zst> [--target DIR] [--force]}"; shift
TARGET="${VH_DATA_DIR:-$HOME/virtual-home-data}"; FORCE=0
while [ $# -gt 0 ]; do case "$1" in
  --target) TARGET="$2"; shift 2;;
  --force)  FORCE=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done

[ -f "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE" >&2; exit 1; }
if [ -f "$ARCHIVE.sha256" ]; then
  echo "$(cat "$ARCHIVE.sha256")  $ARCHIVE" | shasum -a 256 -c - \
    || { echo "FATAL: checksum mismatch" >&2; exit 1; }
fi

# Refuse to clobber live data unless forced. Restores go to an EMPTY dir.
if [ -e "$TARGET/db/app.db" ] && [ "$FORCE" = "0" ]; then
  echo "FATAL: $TARGET/db/app.db exists. Use --force (stop the services first!)." >&2; exit 1
fi
if [ "$FORCE" = "1" ]; then
  UID_NUM="$(id -u)"
  for j in web worker; do launchctl kill SIGTERM "gui/$UID_NUM/net.machadolucas.virtual-home.$j" 2>/dev/null || true; done
  sleep 3
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
/opt/homebrew/bin/zstd -dc "$ARCHIVE" | /usr/bin/tar -xf - -C "$WORK"
SRC="$(find "$WORK" -maxdepth 1 -type d -name 'vh-*' | head -1)"
[ -n "$SRC" ] || { echo "FATAL: unexpected archive layout" >&2; exit 1; }

echo "--- manifest ---"; cat "$SRC/manifest.json"; echo

/usr/bin/sqlite3 "$SRC/app.db" 'PRAGMA integrity_check;' | head -1 | grep -qx ok \
  || { echo "FATAL: restored DB failed integrity_check" >&2; exit 1; }
/usr/bin/sqlite3 "$SRC/app.db" 'PRAGMA foreign_key_check;' | head -5

mkdir -p "$TARGET"/{db,attachments,model,backups/daily,backups/weekly,exports,secrets,logs,tmp}
chmod 700 "$TARGET" "$TARGET/secrets"
cp "$SRC/app.db" "$TARGET/db/app.db"
rm -f "$TARGET/db/app.db-wal" "$TARGET/db/app.db-shm"   # snapshot is fully checkpointed
rsync -a --delete "$SRC/attachments/" "$TARGET/attachments/"
rsync -a --delete "$SRC/model/"       "$TARGET/model/"
[ -f "$TARGET/secrets/vh.env" ] || {
  cp "$SRC/vh.env.redacted" "$TARGET/secrets/vh.env"; chmod 600 "$TARGET/secrets/vh.env"
  echo "!! vh.env restored WITHOUT secrets — set BETTER_AUTH_SECRET and HA_TOKEN before starting"
}

echo "--- report ---"
/usr/bin/sqlite3 "$TARGET/db/app.db" "
  SELECT 'users',       count(*) FROM user
  UNION ALL SELECT 'sessions',   count(*) FROM session
  UNION ALL SELECT 'attachments',count(*) FROM attachment;"
echo "attachment files: $(find "$TARGET/attachments" -type f | wc -l | tr -d ' ')"
echo "restore complete into $TARGET"
```

Restoring into an **empty** dir by default is the safety property that matters: the most dangerous moment in any backup system is a restore run against live data by mistake.

### 10.3 Round-trip test

`tests/unit/backup-restore.test.ts` — the only real proof a backup works:

1. `mkdtemp` a fake `VH_DATA_DIR`; run all migrations; seed 2 users, 25 attachment rows, 3 real fixture files, a synthetic model package.
2. Record `{ rowCounts, sha256 per attachment file, PRAGMA user_version }`.
3. Spawn `backup.sh` with the env pointed at the fake dir.
4. Assert: archive exists, `.sha256` matches, `zstd -dc | tar -tf` lists `manifest.json` + `app.db`, and **`vh.env.redacted` contains no secret** (`expect(content).not.toMatch(/REDACTED/.source === … )` → assert it *does* contain `<REDACTED>` and does *not* contain the seeded secret value).
5. Spawn `restore.sh` into a second temp dir.
6. Assert row counts identical, every attachment file's sha256 identical, `PRAGMA integrity_check = ok`, `foreign_key_check` empty, and `manifest.schemaVersion` equals the live migration hash.
7. **Compression sanity**: assert the archive is meaningfully smaller than the staged payload — this is the regression test for finding #1, and it would have caught the `tar --zstd` trap.

Also `tests/unit/migrations.test.ts`: apply every migration to an empty DB, then snapshot `SELECT type,name,sql FROM sqlite_master ORDER BY name` and compare against a committed snapshot. Catches "someone edited an applied migration" and drift between `drizzle/` and `schema/`.

---

## 11. Observability

### 11.1 Logging

`pino` JSON to rotating files, `pino-pretty` in dev:

```ts
// src/server/log.ts
import pino from 'pino';
const env = loadEnv(process.env.VH_ROLE as any ?? 'web');
export const log = pino({
  level: env.LOG_LEVEL,
  base: { role: env.role, pid: process.pid },
  redact: {
    paths: ['ha_token','access_token','password','newPassword','currentPassword',
            'token','cookie','set-cookie','authorization',
            'req.headers.authorization','req.headers.cookie','*.access_token'],
    censor: '[redacted]',
  },
  formatters: { level: label => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
}, env.NODE_ENV === 'production'
   ? pino.transport({ target: 'pino-roll',
       options: { file: `${env.logDir}/${env.role}.log`, frequency: 'daily',
                  size: '20m', limit: { count: 14 }, mkdir: true } })
   : pino.transport({ target: 'pino-pretty', options: { colorize: true } }));
```

Two sinks, deliberately:

- **App logs** → `pino-roll`, size- and count-capped (20 MB × 14). Rotation is in-process, so there's no fd-vs-rename problem. This is why `newsyslog` is *not* used for the main logs: `newsyslog` has no `copytruncate`, so renaming a file a long-lived process holds open means it keeps writing to the invisible renamed inode — a classic "logs stopped appearing" trap.
- **launchd capture** (`web.launchd.log`) → only pre-`pino` boot output and hard crashes, rotated on each start by the wrapper (§6.2). Tiny by construction.

Standard fields: `role`, `pid`, `reqId` (from `crypto.randomUUID()`, propagated via `AsyncLocalStorage`), `userId`, `route`, `status`, `ms`, `haState`, `seq`. Never a token, never a password, never a full HA state payload at `info`.

### 11.2 `/api/health` — unauthenticated, minimal, no data

```ts
export const dynamic = 'force-dynamic';
export async function GET() {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
```

It deliberately reveals **nothing** — no version, no uptime, no DB state, no worker status. It answers exactly one question ("is the web process serving?") for `install-macmini.sh`, `update.sh`, and any future uptime check. All diagnostics live behind auth on `/settings/system`. An unauthenticated endpoint that reports schema version and HA connectivity is free reconnaissance the moment a tunnel goes up.

### 11.3 `/settings/system` — authenticated

Server component (`requireSession()`), rendered from DB reads plus a live SSE subscription:

| Panel | Source | Alert condition |
|---|---|---|
| Worker heartbeat | `integration_status.heartbeatAt` | `now - hb > 45 s` → red "Background service not running" |
| HA connection | `integration_status.state`, `haVersion`, `lastOkAt`, `reconnectCount`, `lastError` | `auth_failed` → red with the rotation runbook link; `degraded` → amber |
| DB size | `stat` on `app.db` + `-wal` | `-wal` > 64 MB → amber (checkpoint not keeping up) |
| Last backup | latest `backup_run` | none in 36 h → red |
| Memory | `process_metric`, both roles, 24 h sparkline | RSS > 1.5 × measured p95 (§11.5) |
| Model | `model_version.fingerprint`, asset count, total bytes | fingerprint mismatch vs. files on disk |
| Image capability | `heifViaSharp` / `heifViaSips` probe | neither → amber |
| Cert expiry | `openssl x509 -checkend` via a cached daily check | < 60 days → amber |

### 11.4 Metrics collection

```ts
export const processMetric = sqliteTable('process_metric', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  role:      text('role').notNull(),                 // 'web' | 'worker'
  pid:       integer('pid').notNull(),
  rssBytes:  integer('rss_bytes').notNull(),
  heapUsed:  integer('heap_used_bytes').notNull(),
  external:  integer('external_bytes').notNull(),
  uptimeS:   integer('uptime_s').notNull(),
  at:        integer('at', { mode: 'timestamp_ms' }).notNull(),
}, t => [index('process_metric_at_idx').on(t.at)]);
```

Both processes write one row per `VH_METRICS_INTERVAL_MS` (60 s) from `process.memoryUsage()` + `process.uptime()`. The worker prunes rows older than 14 days hourly (≈40 k rows steady state, negligible). The web process writes its own row from the hub's timer — no extra timer needed.

### 11.5 Resource measurement procedure — and the honest memory budget

Do **not** promise "150 MB". Measure, then set the alert from the measurement. `scripts/measure-resources.sh`:

```bash
#!/bin/bash
# Sample RSS of both processes every 60s for 30 min after a 10-min warm-up.
set -euo pipefail
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
OUT="$DATA_DIR/logs/resources-$(date +%Y%m%d-%H%M%S).tsv"
WEB_PID="$(pgrep -f 'next start' | head -1)"
WRK_PID="$(pgrep -f 'dist/worker/index.js' | head -1)"
[ -n "$WEB_PID" ] && [ -n "$WRK_PID" ] || { echo "processes not running" >&2; exit 1; }

echo "warm-up: 10 min (browse the app, open the 3D model, upload a photo, leave a tab open)"
sleep 600
printf 'ts\trole\tpid\trss_kb\tcpu_pct\n' > "$OUT"
for i in $(seq 1 30); do
  for pair in "web:$WEB_PID" "worker:$WRK_PID"; do
    role="${pair%%:*}"; pid="${pair##*:}"
    read -r rss cpu <<<"$(ps -o rss=,%cpu= -p "$pid" | awk '{print $1, $2}')"
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date +%s)" "$role" "$pid" "${rss:-0}" "${cpu:-0}" >> "$OUT"
  done
  sleep 60
done

echo "--- summary (RSS MB) ---"
awk -F'\t' 'NR>1 {v[$2][++n[$2]]=$4/1024}
  END { for (r in v) { c=n[r]; for(i=1;i<=c;i++) for(j=i+1;j<=c;j++) if(v[r][j]<v[r][i]){t=v[r][i];v[r][i]=v[r][j];v[r][j]=t}
        printf "%-7s n=%d p50=%.1f p95=%.1f max=%.1f  -> alert at %.0f MB\n",
               r, c, v[r][int(c*0.5)+0], v[r][int(c*0.95)], v[r][c], v[r][int(c*0.95)]*1.5 } }' "$OUT"
```

Procedure, written into `docs/operations.md`:

1. Run after `update.sh` on a normally-loaded mini, with one browser tab holding an SSE stream open (that's the realistic steady state).
2. During warm-up exercise the expensive paths: load the 3D model, upload a photo, open a PDF, trigger an HA state change.
3. Record p50 / p95 / max per role in `docs/operations.md` with the date and commit.
4. **Set the alert threshold at 1.5 × measured p95**, not a guessed absolute. Re-measure after any dependency bump that touches sharp, three.js, or Next.
5. Watch for *trend*, not level: a p50 that climbs across weekly measurements is a leak; a high but flat p50 is just Node.

`ps -o rss=` reports resident pages and over-counts shared library pages; treat it as a comparable time series rather than an absolute truth. If a real leak is suspected, `node --heapsnapshot-signal=SIGUSR2` on the worker gives an actionable heap dump.

---

## 12. Security checklist and test list

### 12.1 Route handler / server action checklist

Every handler and action, no exceptions:

- [ ] First statement is `requireSession()` (or `requireFreshSession()` for destructive ops) — via the `authed()` / `action()` wrappers, so it can't be forgotten.
- [ ] All input zod-parsed; no `as any` on request data; unknown keys stripped.
- [ ] Mutating actions accept an `idempotencyKey` and replay through the `idempotency` table.
- [ ] No path from user input to the filesystem without `safeJoin`.
- [ ] File responses: `Cache-Control: private`, correct sniffed `Content-Type`, `nosniff`, RFC 5987 `Content-Disposition`.
- [ ] HTML responses: `Cache-Control: private, no-store, must-revalidate` (set in `proxy.ts` for navigations).
- [ ] Errors return a generic body; details go to the log with a `reqId`. No stack traces to the client.
- [ ] `actorUserId` recorded on every mutation.
- [ ] Nothing private under `public/` (CI deny-list).
- [ ] SSE requires a session and is counted against `VH_SSE_MAX_CLIENTS`.
- [ ] The HA history proxy checks the linked-entity allowlist.
- [ ] No secret in any client component, `NEXT_PUBLIC_*` var, or SSR payload.

### 12.2 Headers (verify with `curl -I`)

| Header | Value |
|---|---|
| `Content-Security-Policy` | §2.3 (`script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`) |
| `X-Frame-Options` / CSP `frame-ancestors` | `DENY` / `'none'` |
| `Referrer-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), usb=(), payment=()` |
| `X-Content-Type-Options` | `nosniff` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cache-Control` (HTML) | `private, no-store, must-revalidate` |
| `Strict-Transport-Security` | **intentionally absent** until a publicly-trusted cert exists |

`camera=()` is correct and not a mistake: photo capture uses `<input type="file" capture>`, which is a file picker and needs no camera permission. Only `getUserMedia` would, and we don't use it.

### 12.3 Test list

**Vitest — auth boundary** (`tests/unit/auth-boundary.test.ts`):
1. Unauthenticated `GET /api/events` → 401.
2. Unauthenticated `GET /api/attachments/<id>` → 401.
3. Unauthenticated `GET /api/model/model.json?v=…` → 401.
4. Unauthenticated `GET /api/upload` (POST) → 401.
5. Unauthenticated page request → 307 to `/login?next=…`.
6. Garbage session cookie → 401 (proves `proxy.ts` is not the boundary).
7. **Expired** session row → 401.
8. **Revoked** session (row deleted) → 401 within `cookieCache.maxAge`; immediate with `requireFreshSession`.
9. `POST /api/auth/sign-up/email` → 403/400 (`disableSignUp`).
10. 6 rapid `/sign-in/username` failures → 429 on the 6th.
11. `GET /api/health` unauthenticated → 200 `{"status":"ok"}` and **no** extra fields.
12. Cross-origin `Origin` header on a sign-in → rejected (`trustedOrigins`).
13. `next` param `//evil.com` and `https://evil.com` → redirect to `/`.

**Vitest — files**: `safeJoin` traversal suite (§9.7); sniffer accepts the 6 allowlisted magics and rejects a renamed `.exe`, a polyglot, and a PDF with `/OpenAction`; upload over `VH_UPLOAD_MAX_BYTES` aborts mid-stream; derivatives contain no EXIF/GPS (assert with `exiftool -json`); HEIC path uses `sips` when sharp lacks HEIF.

**Vitest — events**: outbox coalescing collapses 40 dimmer updates to 1; `Last-Event-ID` newer than retention replays exactly the missing rows; older than retention yields `resync`; a stalled writer is dropped after 5 flushes; the cursor never advances without its rows (transaction atomicity).

**Vitest — migrations / backup**: §10.3.

**Playwright e2e** (`tests/e2e/auth.spec.ts`), the brief's exact scenario:
1. `/login` → click the "Lucas" avatar → password → submit → lands on the protected home page.
2. Fetch a private attachment **with** the session cookie → 200, correct bytes, `Cache-Control: private`.
3. Same URL in a **fresh context with no cookie** → 401.
4. Same for `/api/model/…` and `/api/events`.
5. `/settings/security` → "Sign out everywhere else" → the second browser context's next request → 401 (with `requireFreshSession` on that page, no cache delay).
6. Change password → old password fails, new one succeeds.
7. SSE: open the app, insert an outbox row out-of-band, assert the DOM updates within 2 s.
8. Deep link `/thing/<id>` while logged out → `/login?next=/thing/<id>` → after login, lands on `/thing/<id>` (the HA-notification path).

**Manual verification list (post-install on the mini):**
- [ ] `curl -fsS https://home.machadolucas.net/api/health` → `{"status":"ok"}`, valid cert, no warning.
- [ ] iPhone Safari: same URL, padlock, no interstitial (proves the 3-step CA trust worked).
- [ ] `launchctl print gui/$(id -u)/net.machadolucas.virtual-home.web | grep state` → `running`.
- [ ] Same for `.worker`; `last exit code = 0`.
- [ ] `/settings/system`: worker heartbeat < 45 s old, HA `subscribed`, `haVersion` populated.
- [ ] Toggle a real light in HA → the UI updates within ~1.5 s.
- [ ] `sudo pkill -f dist/worker/index.js` → launchd restarts it within ~10 s; `/settings/system` shows the gap then recovery.
- [ ] Reboot the mini → both jobs come back (confirms auto-login/`RunAtLoad`).
- [ ] Upload a photo from an iPhone → original + web + thumb exist; `exiftool -gps:all` on all three is empty.
- [ ] Open a PDF manual on the iPhone → renders; server log shows a 206.
- [ ] `./scripts/backup.sh` → archive < 60 % of payload size (finding #1 guard), `.sha256` verifies.
- [ ] `./scripts/restore.sh <archive> --target /tmp/vh-test` → integrity ok, row counts match.
- [ ] `pnpm vh-admin doctor` → all green.
- [ ] `grep -r "$(cut -c1-8 <<<"$HA_TOKEN")" .next/ public/` → no match.
- [ ] `ls -l ~/virtual-home-data/secrets/vh.env` → `-rw-------`.
- [ ] `git status` after a full day of use → clean (no private data crept into the repo).

---

## 13. Risks and open questions

1. **`internalAdapter` avoided, but `requestPasswordReset` + `resetPassword` still couples the CLI to Better Auth's reset-token internals.** Mitigation is the §4.2 contract test plus an exact version pin. If a future release breaks it, the fallback is `auth.$context` + `ctx.password.hash`, which the test also validates.
2. **launchd user agents need a logged-in session.** Auto-login on the mini is the pragmatic answer but weakens physical security (FileVault still protects at rest, but a booted machine is unlocked). The LaunchDaemon alternative needs root and is documented. **Open: does the owner accept auto-login?**
3. **mkcert CA on iPhones is a manual, expiring ritual.** Certs last ~2 y 3 m; a forgotten renewal breaks HA notification links for both users. A publicly-trusted cert via DNS-01 + cloudflared removes this entirely and is the recommended medium-term move.
4. **`x-forwarded-for` is trusted.** Safe only while the app port is loopback-bound and nginx overwrites the header. If `HOST=0.0.0.0` is ever set without removing that trust, rate limits become spoofable. `doctor` should flag `HOST=0.0.0.0` + `ipAddressHeaders` together.
5. **The two-writer SQLite setup depends on `BEGIN IMMEDIATE` discipline.** One deferred write transaction added later can produce intermittent `SQLITE_BUSY_SNAPSHOT` under concurrency. Enforced only by convention and `CLAUDE.md` — **open: is a lint rule or a wrapper that forbids raw `db.transaction()` worth building?**
6. **1 s SSE latency** is a deliberate trade. If a future feature needs true real-time (a live camera overlay, a game), the nudge endpoint (§7.1) is the pre-designed answer.
7. **HA registry APIs are in motion** (2026.8–2026.9 device changes; `remove_config_entry` gone in 2027.9). Lenient parsing plus a `worker` integration test against a recorded fixture is the defence, but an HA upgrade could still surprise. Consider pinning an HA version window in `docs/decisions.md`.
8. **`exiftool` is a Homebrew dependency** for GPS stripping of stored originals. The fallback leaves metadata on non-JPEG originals with a UI flag. **Open: acceptable, or should originals always be re-encoded (losing fidelity) to guarantee no metadata?**
9. **No offsite backup.** Everything lives on one Mac mini; a disk failure or theft loses the household's data. Time Machine or an `rclone` push of `backups/` to encrypted cloud storage is out of scope here but should be the next operational task.
10. **`'unsafe-inline'` in `script-src`** is right for a LAN app with two trusted users, and wrong the moment this is publicly reachable. The cloudflared decision must re-open this ADR.

---

### Critical Files for Implementation

- `/Users/machadolucas/git/virtual-home/src/server/auth/auth.ts` — the auth options factory; §3.1 and §4 both depend on it, including the `AuthVariant` seam that makes the session-free recovery CLI possible.
- `/Users/machadolucas/git/virtual-home/src/env.ts` — role-aware zod config; every other module reads its paths and flags from here, and `cookieSecure` derivation is what makes the HTTP fallback a one-line change.
- `/Users/machadolucas/git/virtual-home/src/server/events/hub.ts` — the singleton outbox poller, coalescing, and backpressure; the whole live-update design lives or dies here.
- `/Users/machadolucas/git/virtual-home/src/worker/ha/socket.ts` — the HA WebSocket state machine, jittered backoff, ping heartbeat, and the re-snapshot-on-reconnect rule.
- `/Users/machadolucas/git/virtual-home/scripts/backup.sh` — must pipe through `zstd` rather than use `tar --zstd` (measured 33× regression that exits 0), and is the file the round-trip test guards.
- `/Users/machadolucas/git/virtual-home/scripts/install-macmini.sh` — idempotent provisioning, secret generation, port-conflict check, and the launchd `bootout`/`bootstrap` reload idiom.

Sources: [Better Auth admin plugin](https://www.better-auth.com/docs/plugins/admin), [users & accounts](https://www.better-auth.com/docs/concepts/users-accounts), [email & password](https://www.better-auth.com/docs/authentication/email-password), [options reference](https://www.better-auth.com/docs/reference/options), [username plugin](https://www.better-auth.com/docs/plugins/username), [Next.js integration](https://www.better-auth.com/docs/integrations/next), [Next.js 16 blog](https://nextjs.org/blog/next-16), [serverActions config](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions), [sharp install](https://sharp.pixelplumbing.com/install/), [HA WebSocket API](https://developers.home-assistant.io/docs/api/websocket/), [HA device registry changes](https://developers.home-assistant.io/blog/2026/08/19/device-registry-websocket-api-changes/), [entity_registry_updated stale values](https://github.com/home-assistant/core/issues/134613), [force password change without session](https://github.com/better-auth/better-auth/issues/1173)