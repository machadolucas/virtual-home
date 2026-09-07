#!/bin/bash
# Idempotent install/upgrade on the Mac mini. Safe to re-run.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
ENV_FILE="$DATA_DIR/secrets/vh.env"; UID_NUM="$(id -u)"; LA="$HOME/Library/LaunchAgents"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mFATAL:\033[0m %s\n' "$*" >&2; exit 1; }

say "checking toolchain"
command -v node >/dev/null || die "node not found (brew install node@24)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || die "node 24+ required, found $(node -v)"
command -v pnpm >/dev/null || die "pnpm not found (corepack enable pnpm  OR  brew install pnpm)"
for t in sqlite3 zstd openssl tar; do command -v "$t" >/dev/null || die "$t not found (brew install $t)"; done

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
grep -q '^HA_TOKEN=REPLACE_ME$' "$ENV_FILE" && die "HA_TOKEN still REPLACE_ME in $ENV_FILE"
set -a; . "$ENV_FILE"; set +a

if lsof -nP -iTCP:"${PORT:-3010}" -sTCP:LISTEN >/dev/null 2>&1; then
  OWNER="$(lsof -nP -iTCP:"${PORT:-3010}" -sTCP:LISTEN -F c | sed -n 's/^c//p' | head -1)"
  case "$OWNER" in node|next-server) ;; *) die "port ${PORT:-3010} is held by '$OWNER'; pick another PORT in $ENV_FILE";; esac
fi

say "installing dependencies"; cd "$APP_DIR"; pnpm install --frozen-lockfile
say "building web + worker"; pnpm run build
if [ -f "$DATA_DIR/db/app.db" ]; then say "pre-migration backup"; "$APP_DIR/scripts/backup.sh" --label pre-migration --keep-forever; fi
say "applying migrations"; VH_ROLE=cli pnpm run db:migrate

say "installing launch agents"; mkdir -p "$LA"
for job in web worker backup; do
  SRC="$APP_DIR/scripts/launchd/net.machadolucas.virtual-home.$job.plist"; DST="$LA/net.machadolucas.virtual-home.$job.plist"
  sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__DATA_DIR__|$DATA_DIR|g" "$SRC" > "$DST"
  plutil -lint "$DST" >/dev/null || die "invalid plist: $DST"
  launchctl bootout "gui/$UID_NUM/net.machadolucas.virtual-home.$job" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$DST"
  launchctl enable "gui/$UID_NUM/net.machadolucas.virtual-home.$job"
done

if [ "$(sqlite3 "$DATA_DIR/db/app.db" 'SELECT count(*) FROM user;' 2>/dev/null || echo 0)" = "0" ]; then
  say "no users yet - run:  pnpm vh-admin init-users"
fi
say "waiting for health"
for i in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${PORT:-3010}/api/health" >/dev/null 2>&1 && { say "web healthy on 127.0.0.1:${PORT:-3010}"; break; }
  [ "$i" = 40 ] && die "web did not become healthy; see $DATA_DIR/logs/web.launchd.log"; sleep 1
done
launchctl print "gui/$UID_NUM/net.machadolucas.virtual-home.worker" 2>/dev/null | grep -E 'state|last exit' || true
say "done. Point Caddy at 127.0.0.1:${PORT:-3010} (see deploy/Caddyfile.example) and import the model: pnpm vh-admin model-import <dir>"
