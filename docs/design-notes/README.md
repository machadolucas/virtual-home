# Design notes (September 2026 design passes)

These three documents are the detailed design passes produced before implementation started.
They are **reference material**, not the source of truth: where `docs/*.md`, `CLAUDE.md` or the code
differ, those win. Known superseded parts:

- `auth-security-operations.md` §5 (nginx + mkcert): TLS is terminated by the owner's **Caddy** on the
  Mac mini (later a cloudflared tunnel); the app binds `127.0.0.1:3010`. See `docs/operations.md`.
- Delivery time default is `09:00` (provisional), not `07:30`.
- Instants are stored as plain epoch-millisecond integers (`integer(..., { mode: 'number' })`), not
  Drizzle `timestamp_ms` Dates, everywhere.
- The `fixed_weekly` recurrence kind is not implemented in the first version.
- The repository uses `src/app` (Next `--src-dir`), so `proxy.ts`/`instrumentation.ts` live in `src/`.
