# Deploying to the Mac mini

This is the first-time install on the machine that will actually run the app, plus what to do
afterwards. It assumes the mini already runs Caddy and that a `cloudflared` tunnel may be added
later. The app itself always binds `127.0.0.1:3010`; Caddy owns TLS and the hostname.

Everything private lives in `~/virtual-home-data` (mode 700). The repository contains no household
data, so a fresh clone plus that directory is the whole installation.

## 0. What to have ready

| Thing | Why | Where it comes from |
|---|---|---|
| The repo URL | the code | `https://github.com/machadolucas/virtual-home.git` |
| The house-model package (zip) | the 3D house | the reconstruction session; unzip so `model.json` is at the folder's top level |
| The origin you will type in a browser | cookies and CSRF are bound to it | a Caddy site name, e.g. `https://home.example.net` |
| Home Assistant base URL | live state | e.g. `http://192.168.1.181:8123` |
| A Home Assistant long-lived token | live state + push | HA → your profile → Security → Long-lived access tokens. **Optional at install time.** |
| Two passwords (≥ 12 characters) | the accounts for you and Marja | chosen at `init-users`, typed into a hidden prompt |

The token is optional on purpose: without it everything except live entity state and push
notifications works, and the worker says so in its log. Add it whenever you like and restart the
worker.

## 1. Prerequisites

```bash
brew install node@24 pnpm sqlite zstd
brew install exiftool          # optional: lossless GPS strip from stored photo originals
node -v                        # must print v24 or newer
```

If `node -v` is older, `brew link --overwrite node@24` (or add its `bin` to `PATH`). `pnpm` can also
come from `corepack enable pnpm`.

## 2. Install

```bash
mkdir -p ~/git && cd ~/git
git clone https://github.com/machadolucas/virtual-home.git
cd virtual-home

./scripts/install-macmini.sh          # first pass: creates ~/virtual-home-data + a secrets template, then stops
```

Edit the secrets file it created (it is mode 0600 and must stay that way):

```bash
nano ~/virtual-home-data/secrets/vh.env
```

- `VH_BASE_URL` — the exact origin you will use, scheme and host (and port if not 443). This one
  matters: Better Auth checks the `Origin` header against it and Next.js checks server-action
  origins, so a mismatch shows up as sign-in failures rather than a warning.
- `VH_TRUSTED_ORIGINS` — leave equal to `VH_BASE_URL` unless you use two names.
- `HA_URL` — your Home Assistant.
- `HA_TOKEN` — paste the long-lived token, or set it empty (`HA_TOKEN=`) to install without HA.
- `BETTER_AUTH_SECRET` — already generated; do not change it later without reading
  [operations.md](operations.md) (it invalidates every session).

Then run the installer again. It installs dependencies, builds the web app and the worker, applies
migrations (taking a backup first if a database already exists), installs the three launchd
services, and waits for the health endpoint:

```bash
./scripts/install-macmini.sh
pnpm vh-admin init-users              # creates lucas and marja, hidden password prompts
```

## 3. The house model

Unzip so that `model.json`, `manifest.schema.json` and `assets/` sit directly inside the folder you
import (macOS zips often add a wrapper directory — check before importing):

```bash
mkdir -p ~/virtual-home-data/model-incoming
unzip -o ~/Downloads/house-model.zip -d ~/virtual-home-data/model-incoming
ls ~/virtual-home-data/model-incoming/house-model     # model.json  manifest.schema.json  assets/  README.md
pnpm vh-admin model-import ~/virtual-home-data/model-incoming/house-model
```

The import validates the manifest, copies the package to `model/<fingerprint>/`, records the
revision, and mirrors the buildings, floors and rooms into the app's location tree. Warnings about
the package's own known issues are expected; errors are not. A re-import of the same package is a
no-op, and a changed package opens an explicit reconciliation under Settings → House model rather
than moving anything by itself.

## 4. Caddy

Add a site block (adapt the hostname) and reload Caddy. `flush_interval -1` is required: the live
updates are Server-Sent Events, and a buffering proxy makes them arrive in clumps or not at all.

```caddyfile
home.example.net {
	encode zstd gzip
	request_body {
		max_size 32MB
	}
	reverse_proxy 127.0.0.1:3010 {
		flush_interval -1
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-Host {host}
		transport http {
			read_timeout 0
		}
	}
}
```

`deploy/Caddyfile.example` holds the same snippet. Validate and reload with Caddy's own tooling
(`caddy validate --config <your Caddyfile>` then `caddy reload --config <your Caddyfile>`, or
`brew services reload caddy` if that is how it runs here). If the certificate is Caddy's internal
CA, trust it on both phones once; a public certificate via the tunnel needs no trust step.

When the `cloudflared` tunnel arrives, point it at this Caddy site (or straight at
`127.0.0.1:3010`), then set `VH_BASE_URL`/`VH_TRUSTED_ORIGINS` to the public hostname and restart the
web service. Nothing else changes — that is the only place the origin is configured.

## 5. Home Assistant

1. HA → profile → Security → Long-lived access tokens → create one named `virtual-home-worker`.
2. Put it in `~/virtual-home-data/secrets/vh.env` as `HA_TOKEN=…` (never anywhere else; it is not
   entered in the browser and never logged).
3. Restart the worker: `launchctl kickstart -k gui/$(id -u)/net.machadolucas.virtual-home.worker`
4. Open Settings → Home Assistant: the connection should reach `subscribed`, with a version and a
   recent "last successful message".
5. Settings → Users: give each person their notify service (`notify.mobile_app_lucas_iphone`,
   `notify.mobile_app_marja_helenas_iphone`). Nothing is sent to a person without one.
6. Settings → Home Assistant → import: create equipment from HA devices and link the entities you
   care about. Areas and floors can be mapped to rooms in the same place; suggestions are never
   applied on their own.

## 6. Verify

```bash
pnpm vh-admin doctor                                     # env, permissions, integrity, migrations, HA, services, disk
curl -fsS http://127.0.0.1:3010/api/health               # {"status":"ok"}
launchctl print gui/$(id -u)/net.machadolucas.virtual-home.web    | grep -E 'state|last exit'
launchctl print gui/$(id -u)/net.machadolucas.virtual-home.worker | grep -E 'state|last exit'
tail -f ~/virtual-home-data/logs/worker.log
```

Then in a browser at your `VH_BASE_URL`:

- Sign in as Lucas; the shell and the House view are both in the theme you chose (System / Light /
  Dark in the account menu).
- House: the model loads, a room selects from the tree and from the 3D view, floors isolate, the
  section slider cuts, colours change and survive a reload.
- Settings → System: worker heartbeat is seconds old, HA state is correct, the last backup appears
  after the first nightly run (03:30) or after `./scripts/backup.sh`.
- Create one real maintenance plan, complete it, and check History and the supply ledger.
- Toggle something in Home Assistant and watch the state change in the app within a second or two.
- Send yourself a notification by making a task due today with the delivery time a minute ahead, and
  tap it on the phone: it should open the task after sign-in.

## 7. Afterwards

```bash
cd ~/git/virtual-home && ./scripts/update.sh    # backup → pull → test → migrate → build → restart, in that order
./scripts/backup.sh                             # on demand; nightly at 03:30 by launchd
./scripts/restore.sh <archive> --target /tmp/restore-test
WARMUP_S=600 ./scripts/measure-resources.sh     # record p50/p95 RSS in operations.md
pnpm vh-admin set-password lucas                # the only password reset path
pnpm vh-admin revoke-sessions --all
```

Details, rotation procedures and the backup/restore contract are in [operations.md](operations.md);
the trust model is in [security.md](security.md).

## Caveats specific to this machine

- **launchd user agents run only while the user is logged in.** Either enable automatic login for
  this account, or move the three plists to `/Library/LaunchDaemons` with a `UserName` key and
  `sudo launchctl bootstrap system …`. Without one of those, a reboot leaves the app down.
- **Port 3010** is the default because 3000 is often taken. If the installer reports a conflict,
  change `PORT` in `vh.env` and the Caddy upstream together.
- **The web process must not be started with `pnpm exec`** in production; the launchd wrapper execs
  `node` directly, which keeps about 120 MB of launcher process out of the picture.
- **Worker memory** settles around 110 MB but spikes on the first minute after start; see the
  measured table in [operations.md](operations.md) and re-measure here before setting an alert.
- **HA history proxy**: `VH_HA_HISTORY_ENABLED=false` in `vh.env` removes the only path that lets the
  web process hold the HA token, if you would rather keep it worker-only.
