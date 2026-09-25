#!/bin/bash
# Idempotent install/upgrade on the Mac mini. Safe to re-run.
#
# Usage: install-macmini.sh [--plists-only] [--domain gui|system]
#   --plists-only   only (re)render the launchd plists: no dependency install, build or migration
#   --domain D      render for D instead of VH_LAUNCHD_DOMAIN from secrets/vh.env (default gui)
#
# gui mode installs per-user LaunchAgents and (re)loads them, as it always has. system mode renders
# LaunchDaemons that run as the current user into $VH_DATA_DIR/launchd-staged/ and PRINTS the sudo
# lines that install them; this script never runs sudo. See docs/deploy-mac-mini.md.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
ENV_FILE="$DATA_DIR/secrets/vh.env"; UID_NUM="$(id -u)"; LA="$HOME/Library/LaunchAgents"
STAGE="$DATA_DIR/launchd-staged"; DAEMONS=/Library/LaunchDaemons
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mFATAL:\033[0m %s\n' "$*" >&2; exit 1; }
# shellcheck source=lib/launchd.sh
. "$APP_DIR/scripts/lib/launchd.sh"

PLISTS_ONLY=0; DOMAIN_ARG=""
while [ $# -gt 0 ]; do case "$1" in
  --plists-only) PLISTS_ONLY=1; shift;;
  --domain) DOMAIN_ARG="${2:-}"; [ -n "$DOMAIN_ARG" ] || die "--domain needs gui or system"; shift 2;;
  -h|--help) sed -n '2,10p' "$0"; exit 0;;
  *) die "unknown argument: $1 (see --help)";;
esac; done

if [ "$PLISTS_ONLY" = 0 ]; then
  say "checking toolchain"
  command -v node >/dev/null || die "node not found (brew install node@24)"
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || die "node 24+ required, found $(node -v)"
  command -v pnpm >/dev/null || die "pnpm not found (corepack enable pnpm  OR  brew install pnpm)"
  for t in sqlite3 zstd openssl tar; do command -v "$t" >/dev/null || die "$t not found (brew install $t)"; done
fi

say "creating $DATA_DIR"
for d in db model model-incoming attachments backups/daily backups/weekly exports secrets logs tmp; do mkdir -p "$DATA_DIR/$d"; done
chmod 700 "$DATA_DIR" "$DATA_DIR/secrets"

if [ ! -f "$ENV_FILE" ]; then
  say "creating $ENV_FILE"
  umask 077
  cat > "$ENV_FILE" <<ENV
# virtual-home secrets and config - mode 0600, NEVER in git
NODE_ENV=production
VH_DATA_DIR=$DATA_DIR
# Public origin served by Caddy (later the cloudflared domain). Must match what users type.
VH_BASE_URL=https://home.example.net
VH_TRUSTED_ORIGINS=https://home.example.net
VH_HOUSEHOLD_TZ=Europe/Helsinki
VH_DELIVERY_TIME=09:00
HOST=127.0.0.1
PORT=3010
LOG_LEVEL=info
BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
HA_URL=http://192.168.1.181:8123
HA_TOKEN=REPLACE_ME
ENV
  chmod 600 "$ENV_FILE"
  say "edit $ENV_FILE (VH_BASE_URL, HA_TOKEN), then re-run this script"; exit 0
fi
chmod 600 "$ENV_FILE"
# An empty HA_TOKEN is allowed: the app installs and runs without Home Assistant, and the worker
# says so at start-up. Only the untouched placeholder is refused, because that is an unread file.
if grep -q '^HA_TOKEN=REPLACE_ME$' "$ENV_FILE"; then
  say "HA_TOKEN is still the placeholder in $ENV_FILE"
  say "Either paste a Home Assistant long-lived token, or set 'HA_TOKEN=' (empty) to install without"
  say "Home Assistant for now — everything except live state and push notifications works."
  die "edit $ENV_FILE and re-run"
fi
set -a; . "$ENV_FILE"; set +a
[ -n "${HA_TOKEN:-}" ] || say "note: HA_TOKEN is empty — installing without Home Assistant (add it later and restart the worker)"
DOMAIN="$(VH_LAUNCHD_DOMAIN="${DOMAIN_ARG:-${VH_LAUNCHD_DOMAIN:-}}" vh_resolve_domain)" || exit 78
if [ "$DOMAIN" = system ] && [ "$UID_NUM" = 0 ]; then
  die "run this as the user the app should run as, not with sudo: the daemons take UserName and HOME from it"
fi

if lsof -nP -iTCP:"${PORT:-3010}" -sTCP:LISTEN >/dev/null 2>&1; then
  OWNER="$(lsof -nP -iTCP:"${PORT:-3010}" -sTCP:LISTEN -F c | sed -n 's/^c//p' | head -1)"
  case "$OWNER" in node|next-server) ;; *) die "port ${PORT:-3010} is held by '$OWNER'; pick another PORT in $ENV_FILE";; esac
fi

if [ "$PLISTS_ONLY" = 0 ]; then
  say "installing dependencies"; cd "$APP_DIR"; pnpm install --frozen-lockfile
  say "building web + worker"; pnpm run build
  if [ -f "$DATA_DIR/db/app.db" ]; then say "pre-migration backup"; "$APP_DIR/scripts/backup.sh" --label pre-migration --keep-forever; fi
  say "applying migrations"; VH_ROLE=cli pnpm run db:migrate
fi

if [ "$DOMAIN" = system ]; then
  say "staging system LaunchDaemons (run as $(id -un):$(id -gn)) in $STAGE"
  mkdir -p "$STAGE"; chmod 700 "$STAGE"
  for job in web worker backup; do
    SRC="$APP_DIR/scripts/launchd/$(vh_label "$job").plist"; DST="$STAGE/$(vh_label "$job").plist"
    vh_render_plist "$SRC" "$DST" "$APP_DIR" "$DATA_DIR" system "$job" || die "invalid plist: $DST"
  done
  for job in web worker backup; do
    if vh_is_loaded "$(vh_target gui "$job")"; then
      say "WARNING: $(vh_target gui "$job") is still loaded. Boot the LaunchAgents out and move their plists"
      say "out of $LA before bootstrapping the daemons, or two copies will fight over port ${PORT:-3010}."
      break
    fi
  done
  LOADED=1
  for job in web worker backup; do vh_is_loaded "$(vh_target system "$job")" || LOADED=0; done
  if [ "$LOADED" = 1 ]; then
    if [ "$PLISTS_ONLY" = 0 ]; then
      say "restarting worker and web onto the new build (hold, stop by pid, release; no sudo)"
      vh_hold_and_stop "$DATA_DIR" system worker web || die "could not stop the services; they stay held by $DATA_DIR/run/hold"
      vh_release_and_wait "$DATA_DIR" system "${PORT:-3010}" web worker || die "services did not come back; see $DATA_DIR/logs/*.launchd.log*"
    fi
    say "the daemons are loaded already. If a staged plist changed, replace it with (as root):"
  else
    say "not loaded yet. Install the daemons with (as root; this script never runs sudo):"
  fi
  for job in web worker backup; do
    L="$(vh_label "$job")"
    printf '  sudo launchctl bootout system/%s 2>/dev/null || true\n' "$L"
    printf '  sudo install -o root -g wheel -m 600 %q %s\n' "$STAGE/$L.plist" "$DAEMONS/$L.plist"
    printf '  sudo launchctl bootstrap system %s\n' "$DAEMONS/$L.plist"
  done
  if [ "$LOADED" = 0 ]; then
    say "then check: curl -fsS http://127.0.0.1:${PORT:-3010}/api/health  and  pnpm vh-admin doctor"
    exit 0
  fi
else
  say "installing launch agents"; mkdir -p "$LA"
  for job in web worker backup; do
    SRC="$APP_DIR/scripts/launchd/net.machadolucas.virtual-home.$job.plist"; DST="$LA/net.machadolucas.virtual-home.$job.plist"
    vh_render_plist "$SRC" "$DST" "$APP_DIR" "$DATA_DIR" gui "$job" || die "invalid plist: $DST"
    launchctl bootout "gui/$UID_NUM/net.machadolucas.virtual-home.$job" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_NUM" "$DST"
    launchctl enable "gui/$UID_NUM/net.machadolucas.virtual-home.$job"
  done
fi

if [ "$(sqlite3 "$DATA_DIR/db/app.db" 'SELECT count(*) FROM user;' 2>/dev/null || echo 0)" = "0" ]; then
  say "no users yet - run:  pnpm vh-admin init-users"
fi
say "waiting for health"
for i in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${PORT:-3010}/api/health" >/dev/null 2>&1 && { say "web healthy on 127.0.0.1:${PORT:-3010}"; break; }
  [ "$i" = 40 ] && die "web did not become healthy; see $DATA_DIR/logs/web.launchd.log"; sleep 1
done
launchctl print "$(vh_target "$DOMAIN" worker)" 2>/dev/null | grep -E 'state|last exit' || true
say "done. Point Caddy at 127.0.0.1:${PORT:-3010} (see deploy/Caddyfile.example) and import the model: pnpm vh-admin model-import <dir>"
