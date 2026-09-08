#!/bin/bash
# launchd wrapper for the web process: loads secrets, rotates the launchd capture log, execs next.
set -euo pipefail
APP_DIR="${VH_APP_DIR:-$HOME/git/virtual-home}"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
ENV_FILE="$DATA_DIR/secrets/vh.env"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
for i in 3 2 1; do
  [ -f "$LOG_DIR/web.launchd.log.$i" ] && mv -f "$LOG_DIR/web.launchd.log.$i" "$LOG_DIR/web.launchd.log.$((i+1))" || true
done
[ -f "$LOG_DIR/web.launchd.log" ] && mv -f "$LOG_DIR/web.launchd.log" "$LOG_DIR/web.launchd.log.1" || true
if [ ! -f "$ENV_FILE" ]; then echo "FATAL: missing $ENV_FILE" >&2; exit 78; fi
if [ "$(stat -f '%Lp' "$ENV_FILE")" != "600" ]; then echo "FATAL: $ENV_FILE must be mode 600" >&2; exit 78; fi
set -a; . "$ENV_FILE"; set +a
export VH_DATA_DIR="$DATA_DIR" NODE_ENV=production VH_ROLE=web
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$APP_DIR"
# exec node directly: `pnpm exec` would leave a ~120 MB pnpm process resident for the whole run.
exec node node_modules/next/dist/bin/next start --hostname "${HOST:-127.0.0.1}" --port "${PORT:-3010}"
