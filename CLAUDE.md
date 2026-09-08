# virtual-home — agent guide

Local home-management app for one household (two named users). Next.js 16 App Router + a separate
Node worker sharing `src/domain`. SQLite (Drizzle + better-sqlite3). Better Auth. Home Assistant
integration (read state, send mobile notifications). 3D house workspace (React Three Fiber) driven by
a supplied, immutable house-model package.

Read `docs/architecture.md` first, then the doc for the area you touch. Durable decisions live in
`docs/decisions.md` (ADR-lite). The original design passes are in `docs/design-notes/` (reference
only; `docs/*.md` and code win where they differ).

## Commands
- `pnpm dev` — web on http://localhost:3010 (Turbopack). `pnpm worker:dev` — worker with tsx watch.
- `pnpm check` — typecheck + lint + unit/integration tests (run before every commit).
- `pnpm test` / `pnpm test:e2e` — Vitest / Playwright.
- `pnpm db:generate` — drizzle-kit SQL migration from `src/db/schema/*`; `pnpm db:migrate` applies
  (with a pre-migration backup in production).
- `pnpm vh-admin <cmd>` — server-side admin CLI (users, passwords, sessions, model import, doctor).
- `pnpm build` — `next build` + esbuild worker bundle to `dist/worker`.

Configuration: see `.env.example`. Dev uses `.env.local` (gitignored); production uses
`$VH_DATA_DIR/secrets/vh.env` (mode 0600). `src/env.ts` validates everything at startup.

## Hard rules (do not bend these)
1. **Nothing private in this public repo**: no household data, photos, manuals, the real model
   package, databases, or secrets. Tests use the synthetic fixture in `tests/fixtures/model/`.
2. **Every route handler, server action and page starts with `requireSession()`** (or
   `requireFreshSession()` for destructive/security operations). `src/proxy.ts` is only an optimistic
   redirect, never the authorization boundary. Private files (model, attachments) are served only
   through authenticated route handlers, never from `public/`.
3. **Every write transaction uses `writeTx()` (BEGIN IMMEDIATE)** from `src/db/client.ts`. Keep
   transactions short; chunk bulk work.
4. **Time**: instants are epoch-millisecond integers (`*_ms`); household calendar dates are
   `YYYY-MM-DD` text; wall-clock times `HH:MM`. All calendar math goes through `src/domain/time.ts`
   with an injectable `Clock` and the household time zone. Never add `7 * 86400000` to get "next week".
5. **Quantities** are integers in thousandths (`*_milli`; 2 pcs = 2000); money in cents.
6. **Never fabricate maintenance history.** Setup writes a schedule anchor, not a completion.
   Snooze changes nothing but reminders. Booking a professional is not completion. Telemetry
   recovering is not proof of maintenance.
7. **Model package is immutable input.** Runtime data references `modelId` + semantic IDs
   (`roomId`, `surfaceId`, …) + physical metre coordinates. Exploded/cutaway views are presentation
   transforms; never persist them. Colouring mutates only the surface's own material.
8. **HA identities**: link by entity registry id / device id (and platform+unique_id), never by
   display name. `unknown`/`unavailable` is never a value (never 0 %).
9. **Notifications**: idempotent by design (tags, nonces, `completion.request_id`); we record `sent`,
   never `delivered`.
10. Prefer boring, explicit code over clever abstractions. No multi-tenancy, no role hierarchy.

## Layout
`src/app` (routes) · `src/domain` (pure logic, shared) · `src/db` (schema, client, migrations) ·
`src/server` (auth, api wrappers, events hub, files, HA registry, logging) · `src/house` (3D
workspace) · `src/ui` (design system) · `src/worker` (HA socket, scheduler, outbox drain, jobs) ·
`scripts/` (install/update/backup/restore/admin) · `tests/` (unit, integration, e2e, fixtures) ·
`docs/`.

## Schema changes — read before editing `src/db/schema`
- Additive only where possible (`ALTER TABLE ADD COLUMN`). **Never add or change a CHECK/UNIQUE on
  an existing table that has child tables with `ON DELETE CASCADE`**: drizzle-kit rebuilds the table
  (create-copy-drop), and the `DROP TABLE` cascades into the children inside the migration
  transaction (`PRAGMA foreign_keys=OFF` is a no-op there). `drizzle/0002_sad_raza.sql` documents the
  case that would have deleted every route point. Enforce such rules in code instead.
- After `pnpm db:generate`, read the SQL. Update the schema snapshot test with `vitest -u` only for
  the change you made. Migrations are forward-only; two-phase drops.
- CLI/worker code that imports `src/server/**` must import `scripts/lib/serverOnly` first (the
  `server-only` guard throws outside Next).

## Conventions
- TypeScript strict, `noUncheckedIndexedAccess`. Zod for all external input (HTTP, HA, model files).
- Server components by default; client components only where interaction needs them; the 3D viewer
  is loaded with `next/dynamic` (`ssr: false`) behind an error boundary.
- Tailwind 4 with design tokens in `src/app/globals.css`; components in `src/ui`.
- Tests are behaviour-focused: fake clock, in-memory SQLite built by the real migrations, fake HA
  WebSocket server. Every scheduling/inventory/auth invariant listed in `docs/verification.md` has a
  test.
- Commit messages: imperative, one topic per commit. No attribution lines.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
