# Architecture

## Processes
| Process | Entry | Responsibilities |
|---|---|---|
| web | `next start` (127.0.0.1:3010) | UI (server components, server actions), route handlers (files, model assets, uploads, SSE, HA history proxy), auth |
| worker | `dist/worker/index.mjs` | HA WebSocket (state, registries, notification actions), scheduler tick (occurrences, reminder slots, catch-up), outbox drain (notify/clear), condition rules (low battery), heartbeat/metrics, housekeeping |
| cli | `pnpm vh-admin` | provisioning, recovery, model import, doctor |
| launchd | plists in `scripts/launchd/` | supervises web + worker; nightly backup job |

Both processes open the same SQLite file (WAL). The worker writes HA state changes and domain events
to `event_outbox`; the web `Hub` polls `event_cursor` every second and streams batches to browsers via
`/api/events` (SSE). The browser never talks to HA.

## Layers
- `src/domain` — pure logic (time, recurrence, occurrence lifecycle, completion + inventory, notification slots, conditions, model reconciliation). Injected `Clock`. Unit-tested with fake time.
- `src/db` — Drizzle schema, migrations, client (`writeTx` = BEGIN IMMEDIATE).
- `src/server` — auth (Better Auth), API wrappers (`authed`, `action`), events hub, files (uploads, sniffing, derivatives), house-model package serving, HA registry cache access, logging.
- `src/house` — 3D workspace (model layer pure; scene imperative; store; components).
- `src/ui` — design system. `src/app` — routes.
- `src/worker` — HA socket, scheduler, outbox drain, jobs.

## Request/authorization flow
`proxy.ts` (cookie presence → redirect/401) → page/handler → `requireSession()` (Better Auth, DB-backed,
60 s cookie cache; `requireFreshSession()` for destructive ops) → zod input → domain service in
`writeTx` → audit + outbox event → response. Private files are streamed only by authenticated
handlers with `Cache-Control: private`.

## Data flow: maintenance
plan (rule + anchor) → occurrence (one open per plan) → worker: pending→due at delivery time →
reminder slots t(n) = instant(anchor + 7n days, 09:00, tz) → outbox command per device → HA notify
(tag per occurrence×recipient) → user taps action → HA event → worker validates nonce/recipient →
snooze or complete (`completion.request_id = 'act:'+nonce`) → completion + stock consumption in one
transaction → clear notifications for both users → next occurrence.

## Data flow: house model
Package installed under `VH_DATA_DIR/model/<fingerprint>/` (`vh-admin model-import`) → validated
(zod + cross-refs) → served with immutable caching keyed by fingerprint → browser loads shell tier
first → SceneIndex (ids → objects) → colour overrides / placements / routes applied by semantic ids
in physical coordinates → exploded/cutaway are presentation-only.

See `docs/data-model.md`, `docs/model-contract.md`, `docs/home-assistant.md`, `docs/worker.md`,
`docs/security.md`, `docs/operations.md`, `docs/ux.md`, `docs/verification.md`.


## MCP transport boundary

`/mcp` is the explicit exception to browser-session authentication. Only that exact path bypasses the optimistic cookie gate. Every POST (Streamable HTTP) and PUT (bounded attachment upload) authenticates an independently supplied bearer credential against its server-side hash, active household user, expiry, revocation and scopes. Cookies alone never authorize MCP. Host and optional Origin must match the configured application base URL. GET/DELETE do not open unauthenticated streams.

Web actions and MCP adapters call transport-neutral operations under `src/server/operations` and shared services. Validation, scheduling, write transactions, audit attribution and events remain shared. Routine authoring commits with atomic connection/operation/payload-bound idempotency; consequential requests are immutable pending records reviewed through a fresh browser session, revalidated and executed once. MCP cannot approve requests. See `docs/mcp.md` for client setup and limits.

PDF extraction runs as a bounded local worker job. `document_text` caches text by attachment hash and extractor version with page references. The viewer uses locally bundled PDF.js and authenticated attachment requests; no household documents go to an external rendering or extraction service.
