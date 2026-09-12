# Operations

Target: Apple Silicon Mac mini (macOS), Node 24, pnpm 11, Homebrew `sqlite3`, `zstd`. TLS and the
public hostname are provided by the owner's **Caddy** (later a cloudflared tunnel). The app itself binds
`127.0.0.1:3010`.

## Layout
| Path | Purpose |
|---|---|
| `~/git/virtual-home` | code (public repo; contains no household data) |
| `~/virtual-home-data/` (`VH_DATA_DIR`, mode 700) | all private state |
| `db/app.db` (+ `-wal`, `-shm`) | SQLite database |
| `model/<fingerprint>/…`, `model/current.json` | installed house-model packages (immutable) |
| `model-incoming/` | drop a new package here before `vh-admin model-import` |
| `attachments/yyyy/mm/` | originals + `.web.jpg` + `.thumb.jpg` |
| `backups/daily`, `backups/weekly` | `vh-<ts>-<label>.tar.zst` + `.sha256` |
| `exports/`, `tmp/`, `logs/` | exports, upload staging (same filesystem), pino + launchd logs |
| `secrets/vh.env` (mode 600) | configuration incl. `BETTER_AUTH_SECRET`, `HA_TOKEN` |

## First install

> Doing it for the first time on the Mac mini? Follow [deploy-mac-mini.md](deploy-mac-mini.md),
> which walks the same steps with the machine-specific caveats. The condensed version:
```bash
git clone https://github.com/machadolucas/virtual-home.git ~/git/virtual-home
cd ~/git/virtual-home && ./scripts/install-macmini.sh      # creates data dir + secrets template, then exits
$EDITOR ~/virtual-home-data/secrets/vh.env                  # VH_BASE_URL, HA_TOKEN
./scripts/install-macmini.sh                                # install deps, build, migrate, launchd
pnpm vh-admin init-users                                    # creates lucas + marja (interactive)
cp -R /path/to/house-model ~/virtual-home-data/model-incoming/
pnpm vh-admin model-import ~/virtual-home-data/model-incoming/house-model
```
Caddy: add the site block from `deploy/Caddyfile.example` (reverse proxy to `127.0.0.1:3010`,
`flush_interval -1` for SSE, `max_size 32MB`), reload Caddy, then open `https://<host>/api/health`.

Home Assistant token: HA → Profile → Security → Long-lived access tokens → name `virtual-home-worker`
→ paste into `vh.env` as `HA_TOKEN=` → `launchctl kickstart -k gui/$(id -u)/net.machadolucas.virtual-home.worker`.

## Supervision (launchd user agents)
Jobs: `net.machadolucas.virtual-home.web`, `.worker` (`KeepAlive` on crash only; a config error exits
78 and stays down), `.backup` (daily 03:30). Wrapper scripts load `secrets/vh.env` and rotate
`logs/*.launchd.log` on every start; application logs go to `logs/web.log` / `logs/worker.log`
(pino-roll, 20 MB × 14).

```bash
launchctl print gui/$(id -u)/net.machadolucas.virtual-home.web | grep -E 'state|last exit'
launchctl kickstart -k gui/$(id -u)/net.machadolucas.virtual-home.worker   # restart
tail -f ~/virtual-home-data/logs/worker.log
```
User agents run only inside a logged-in user session. Either enable automatic login for the service
user on the mini, or install the plists as LaunchDaemons (`/Library/LaunchDaemons`, add
`<key>UserName</key>`, `sudo launchctl bootstrap system …`). Decide at deployment; the installer
assumes user agents.

## Update
```bash
cd ~/git/virtual-home && ./scripts/update.sh
```
Order: pre-update backup → `git pull --ff-only` → install → typecheck + unit tests → stop worker, then
web (boot out the launchd jobs to prevent KeepAlive restarting during the build) → migrate → build → bootstrap web (health wait) → bootstrap worker. Migrations are forward-only and
additive-first; a failed migration prints the restore + rollback commands.

## Backup and restore
`scripts/backup.sh [--label L] [--keep-forever]` produces a consistent archive (SQLite online backup +
integrity check, attachments, reversible quarantine, model packages, redacted env, manifest) piped through `zstd -19`
(`tar --zstd` on macOS barely compresses; do not "simplify" this). Retention 14 daily / 8 weekly;
`--keep-forever` labels (pre-migration, pre-update, manual) are never pruned. Each run is recorded in
`backup_run`; the system page alerts when no backup happened in 36 h.

`scripts/restore.sh <archive> [--target DIR] [--force]` verifies the checksum, restores into an
**empty** directory by default (or stops services and overwrites with `--force`), checks integrity,
and reports row counts. Secrets are never in archives: after a restore set `BETTER_AUTH_SECRET` (all
sessions invalid) and `HA_TOKEN`.

The round trip is exercised by `tests/integration/backup-restore.test.ts`.
Offsite copies are out of scope here: consider Time Machine or an encrypted `rclone` push of `backups/`.

## Account recovery and secrets
```bash
pnpm vh-admin init-users                      # first run: creates whichever household account is missing
pnpm vh-admin list-users
pnpm vh-admin set-password <username>         # resets and revokes that user's sessions
pnpm vh-admin revoke-sessions --all
pnpm vh-admin doctor                          # env, perms, integrity, migrations, HA, launchd, disk
```
Passwords are typed at a hidden prompt and are never accepted as an argument (argv is world-readable
via `ps` and lands in shell history); without a TTY, pipe one in with `--password-from-stdin`. A reset
revokes that user's sessions, but the 60 s session cookie cache can still satisfy an already-issued
cookie on read paths for up to a minute — security pages and destructive actions re-check immediately.
Rotate `BETTER_AUTH_SECRET`: backup → edit `vh.env` → restart web → `revoke-sessions --all` → sign in again.
Rotate `HA_TOKEN`: create the new token first → edit `vh.env` → restart worker → verify HA state on
Settings → System → delete the old token in HA.

## Model package updates
Copy the new package into `model-incoming/`, run `pnpm vh-admin model-import <dir>`. If the fingerprint
is unchanged, nothing happens. If ids/coordinates changed, the app opens a reconciliation (Settings →
Model) and the previous revision stays current until it is applied.

## Resource budget
Run `scripts/measure-resources.sh` after an update on a normally loaded mini (one browser tab with the
3D view open, an SSE stream alive). Record p50/p95/max RSS per process here with the date and commit;
set the alert threshold at 1.5 × measured p95. Watch the trend across updates, not the absolute level.

> The 2026-09-08 Mac mini row is an **idle floor, not a working figure**: the run happened right after the
> install, before any account existed, so there was no signed-in session, no 3D view and no SSE stream — the
> conditions this section asks for. It is a useful lower bound and a starting point for trend watching, but do
> **not** set alerts from it (1.5 × an idle p95 would fire constantly under real use). Re-measure with the House
> view open and a live SSE client, and replace the row.

| Date | Commit | web p50/p95/max (MB) | worker p50/p95/max (MB) |
|---|---|---|---|
| 2026-09-08 (MacBook Pro M5 Pro, dev machine, 8 samples under light load) | b073000+ | 221 / 225 / 225 | 108 / 108 / 108 (start-up spike 321) |
| 2026-09-08 (Mac mini M4, **idle**: no browser tab, no SSE client, 0 sessions, HA disabled; 30 samples @60 s after 600 s warm-up) | 828cad6 +local | 72.1 / 74.2 / 74.3 | 66.9 / 69.0 / 70.3 |

## HTTP-only fallback
If TLS is temporarily unavailable, set `VH_BASE_URL=http://<lan-ip>:3010` and `HOST=0.0.0.0`; cookies
become non-Secure automatically and `doctor` warns. Passwords then cross the LAN in cleartext; treat it
as temporary. Tablet home-screen installation and the service worker also require the normal HTTPS
deployment (browsers permit service workers only in a secure context).

## Tablet home-screen app

On iPad, open the HTTPS app in Safari, sign in, use Share → Add to Home Screen, then open the new
icon. On Android, open the HTTPS app in Chrome and choose Install app from the browser menu. The
installed app starts at Today in a standalone window.

The service worker caches only the public offline document, app icons, manifest and hashed Next.js
build assets. Signed-in pages, RSC payloads, APIs, house-model files and Home Assistant data always
come from the server. When it cannot reach the server, a fresh navigation therefore shows only a
connection-required screen and never household data. Push notifications are not part of the PWA;
household reminders continue to use Home Assistant.


For verification on an installed checkout, use `VH_DIST_DIR=.next-e2e` with the synthetic E2E harness. Its temporary database, model and uploads are separate from household data, and it never replaces the live `.next` build. Stop the synthetic server before rebuilding that directory. WebKit and Chromium browser projects cover desktop and phone layouts.
