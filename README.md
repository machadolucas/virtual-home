# virtual-home

A local, self-hosted home-management app for one household: maintenance plans and guided procedures,
supplies and stock, equipment and infrastructure placed in a measured 3D model of the house, and
Home Assistant integration (live state, mobile notifications).

- Stack: Next.js 16 · React 19 · TypeScript · SQLite (Drizzle) · Better Auth · React Three Fiber ·
  a small Node worker · launchd.
- Docs: start with [`CLAUDE.md`](CLAUDE.md), then [`docs/architecture.md`](docs/architecture.md),
  [`docs/operations.md`](docs/operations.md), [`docs/decisions.md`](docs/decisions.md).
- Deploying it on the household server: [`docs/deploy-mac-mini.md`](docs/deploy-mac-mini.md)
  (and a ready-to-paste agent prompt in [`docs/deploy-mac-mini-prompt.md`](docs/deploy-mac-mini-prompt.md)).
- This repository is public and contains **no household data**: the house model, database, photos,
  manuals and secrets live in a private data directory (`VH_DATA_DIR`).

```bash
pnpm install
cp .env.example .env.local        # set VH_DATA_DIR, BETTER_AUTH_SECRET
pnpm db:migrate
pnpm vh-admin init-users
pnpm dev                          # http://localhost:3010
pnpm worker:dev                   # in a second terminal
pnpm check                        # typecheck + lint + tests
```
