# Decisions (ADR-lite)

Short records of durable choices. Add a new entry when you change a decision; do not rewrite history.
Format: **Decision** · Why · Consequences · Revisit when.

## D-001 Next.js 16 App Router as a local Node service (2026-09-08)
Owner has Next.js experience; server components + server actions + route handlers cover the UI, API
and file serving in one process. `proxy.ts` is only an optimistic redirect. Revisit: never for this scope.

## D-002 SQLite (WAL) via Drizzle + better-sqlite3; two processes share one file
Synchronous driver, mature, prebuilt for Node 24/arm64. Every write uses `BEGIN IMMEDIATE`
(`writeTx`) so `busy_timeout` applies; bulk work is chunked. Consequence: bulk imports must not hold a
long transaction (they block the worker tick). Revisit if a second machine ever needs the data.

## D-003 Separate worker process (esbuild bundle) sharing `src/domain`
Reminders, HA connection and catch-up must run with no browser open. launchd supervises both
processes independently. Not a request-attached job, not a browser timer.

## D-004 Worker → web live updates through a SQLite outbox polled every second, then SSE
Rejected: local IPC (second listening surface, shared secret, silent loss when web restarts) and
both processes connecting to HA (double token exposure, divergent caches). The outbox already
carries `Last-Event-ID` replay. Latency ≤ 1 s is imperceptible for household state. Escape hatch:
a loopback "nudge" endpoint if sub-100 ms ever matters.

## D-005 Instants are epoch-ms integers; calendar facts are local `YYYY-MM-DD`
Range queries and fake clocks are exact; due dates are calendar facts in the household time zone
and must survive DST. Weekly reminder instants are recomputed per slot with `@date-fns/tz`, never
by adding 7 × 86 400 000 ms.

## D-006 Quantities in integer thousandths (`_milli`); money in cents
No float drift when summing ledgers; liquids can still be 2.5 l (2500).

## D-007 Schedule anchor is separate from completion history
`maintenance_plan.schedule_anchor_date/source` seeds scheduling; `completion` rows are facts. Setup
with a known/approximate/unknown last date never creates a completion.

## D-008 One open occurrence per recurring plan, enforced by a partial unique index
Prevents duplicate overdue tasks structurally, not by convention. Same pattern for one pending
reminder slot per recipient and one accepted action per nonce.

## D-009 Kits and components: stock is counted only where goods physically sit
`available(part) = SUM(transactions)`. Opening a kit is an explicit "explode" transaction group.
No derived availability across the kit/component boundary → no double counting by construction.

## D-010 Catch-up consolidation: one notification per (task, recipient), digest above 3 tasks
"Do not replay weeks of missed notifications" is implemented by fast-forwarding the pending slot to
the latest elapsed slot; the weekly rhythm stays anchored to the original due date. Owner may set the
digest threshold to 1 for a single push after any outage.

## D-011 Blocked tasks keep weekly reminders
Policy 3 says remind while incomplete; blocking is not completing. The UI offers "block + snooze
until" for the common "waiting for filters" case.

## D-012 Better Auth with the username plugin; recovery through a variant auth instance
Admin-plugin endpoints require an admin session, so the server-side CLI builds a second auth
instance with sign-up enabled / reset-token capture and uses only public, documented endpoints.
`better-auth` is pinned exactly; a contract test guards provisioning.

## D-013 Cookies: `sameSite=lax`, Secure iff base URL is https, 30-day sliding sessions
Notification links from the HA app are cross-site top-level navigations; `strict` would log users
out on every tap. 60 s cookie cache; destructive pages bypass it.

## D-014 TLS and hostname are the owner's Caddy (later cloudflared); the app binds loopback:3010
Base URL and trusted origins are environment-driven. No HSTS from the app. HTTP fallback documented
as temporary.

## D-015 CSP allows `'unsafe-inline'` scripts
Two trusted users on a private origin, no third-party scripts, React escapes by default;
compensating controls: `react/no-danger` lint error, `object-src 'none'`, `base-uri 'none'`.
Revisit when the app becomes publicly reachable.

## D-016 Model package is immutable; runtime data references semantic IDs + physical metres
Colours per surface, placements, routes and annotations are stamped with the model revision; a new
revision opens an explicit reconciliation (auto-carry only when id, kind and centroid ≤ 0.5 m match).
Exploded/cutaway transforms are never persisted; placement writes require `viewMode: 'normal'`.

## D-017 Viewer: per-surface material mutation for colour, emissive tint for selection
Materials are unique per surface (verified). Emissive never fights the colour override. No
post-processing outline pass.

## D-018 Viewer: visibility is a pure function of view state; per-group clipping planes
Re-resolved fully on every change; floor nodes are indexed across all assets. Two clipping planes
per explode group so cutaway composes with exploded floors (fallback: exclusive modes).

## D-019 Client-side asset tiering deviates from `loadByDefault` ordering
Shell first (interactive), terrain next, structure only when its layer is on, scans opt-in.
`loadByDefault` still governs membership of the default set.

## D-020 HA links use registry ids; registry events are cache-invalidation only
`entity_registry_updated` payloads carry stale values; we re-list. Renames keep links; removals
flag links `missing`; re-pairing only suggests a relink.

## D-021 Low battery: dead band + sustain timers; invalid readings freeze timers
15 %/30 % with 2 h/6 h sustain by default (editable). `unknown`/`unavailable` is never 0 %. Recovery
closes the episode but never the task.

## D-022 HA token may also live in the web process for the optional history proxy
Restricted to linked entities, server-side only, kill switch `VH_HA_HISTORY_ENABLED=false`.

## D-023 Public repository; all household data outside git
Real model package, DB, attachments, manuals and secrets live in `VH_DATA_DIR`. Tests use a
synthetic fixture model.

## D-024 The 3D view's background is CSS on the canvas host, and the WebGL context is `alpha: true`
The viewer used to clear to a hardcoded `0xf4f4f2` and set `scene.background` to the same colour,
which made the workspace the one place in the app that ignored `globals.css` — light while the rest
of the interface was dark. The background is now painted by the host `<div>`: `bg-viewport` (a new
`--vh-viewport` token) when it follows the theme, an inline `backgroundColor` or `linear-gradient()`
when the household has chosen one.

Rejected: a background *texture* or a full-screen gradient mesh. Either means generating or shipping
an image, a second draw call, a resize path, and colour management on a value that is pure chrome —
and `NoToneMapping` exists precisely so that nothing shifts the model's own colours. CSS gradients
need no shader, no geometry and no invalidate loop; the compositor already knows how to draw them.

The trade is a transparent drawing buffer: `alpha: true`, `scene.background = null`,
`setClearAlpha(0)`. That costs one blend of the canvas against the page instead of an opaque
composite, and a complete image export must composite that CSS background with the transparent render. Everything
else is unchanged and deliberately so — `antialias: true`, `stencil: false`,
`localClippingEnabled`, `NoToneMapping`, the dpr policy and `frameloop="demand"`. A background
change triggers exactly one `invalidate()`, because the transparent buffer has to be re-blended over
the new paint and under `frameloop="demand"` nothing else would ask.

Consequence: anything floating over the render must bring its own surface. Room and equipment
labels, the "+N" cluster badge, the marker buttons, the snap read-out and the loading bar all use
`bg-surface/85 … border border-line backdrop-blur-sm shadow-pop`, never a raw white or black wash —
one of the two would vanish against a user gradient. Revisit if the viewer ever needs a
depth-correct sky or an HDRI, which would put the background back in the scene.

## D-025 The 3D background is a household setting; the light/dark theme is per browser
`household_setting.house_background_json` (nullable, NULL = follow the theme, no CHECK — validated
with zod on write, because adding a CHECK to that table would make drizzle-kit rebuild it and the
rebuild cascades into children, see `drizzle/0002_sad_raza.sql`). The model is the household's,
there are two people looking at it, and a per-person viewer background would have them describing
different pictures to each other over the phone. The control says so in words, and appears in two
places for the same setting: Settings → Household → Appearance, and the House workspace's Rendering
section, where you can actually see what you are choosing.

The **theme** goes the other way: System / Light / Dark in the account menu, `vh-theme` in
`localStorage`, applied by a blocking inline script in `<head>` before the first paint. It is a
property of the screen you are looking at, not of the house, and it grants nothing — so it never
touches the database and never needs a session. Revisit if the household ever wants a shared
"kitchen tablet" theme, which would make it a device setting rather than a browser one.

## D-026 Placement compatibility is shared; viewer image export stays local
Picking, numeric editing and placement writes use one semantic mount-surface policy. Soffits encoded
as `other` and exterior faces without a room must retain their real mount kind through save/reload.
The immutable package and database schema are unchanged; synthetic geometry covers those cases.

Image download composites one fresh WebGL frame with the chosen CSS background and projected
label chips using Canvas 2D. Keeping `preserveDrawingBuffer: false` avoids an ongoing rendering
cost for an occasional export; no screenshot service or household-data upload is needed.

## D-027 The PWA caches only a public shell; household data stays network-only
The service worker pre-caches a household-neutral connection-required page, the web manifest and
app icons, and may runtime-cache hashed `/_next/static/` build assets. Every navigation goes to the
server first. Authenticated HTML, RSC payloads, APIs, model assets and Home Assistant data are never
put in a service-worker cache, so an offline tablet cannot expose a previous user's household data.

The consequence is deliberate: the home-screen app installs and opens in a standalone window, but
it does not provide offline household access. A failed fresh navigation shows only the neutral
offline page. Installation requires HTTPS (apart from browser localhost exceptions); the documented
HTTP LAN fallback remains an emergency browser-only mode. Push stays with Home Assistant and is not
part of this service worker.

## D-028 Furnishings are lightweight model records keyed to the stable model id
Furniture changes the useful reading of the house model but is not maintainable equipment. A
`furnishing` row therefore stores only its procedural kind, label, semantic floor/room ids, physical
site position, yaw and dimensions. It has no asset, maintenance, attachment or Home Assistant link.

Rows use the package's stable `modelId` rather than a revision foreign key. Package updates usually
retain semantic ids, so furnishings carry forward without generating reconciliation work. If a
floor disappears, the record remains visible in the editor list and is marked for reassignment; it
does not render against an invented floor and is never silently deleted.
