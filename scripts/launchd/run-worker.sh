#!/bin/bash
# launchd wrapper for the worker process.
set -euo pipefail
APP_DIR="${VH_APP_DIR:-$HOME/git/virtual-home}"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
ENV_FILE="$DATA_DIR/secrets/vh.env"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
for i in 3 2 1; do
  [ -f "$LOG_DIR/worker.launchd.log.$i" ] && mv -f "$LOG_DIR/worker.launchd.log.$i" "$LOG_DIR/worker.launchd.log.$((i+1))" || true
done
[ -f "$LOG_DIR/worker.launchd.log" ] && mv -f "$LOG_DIR/worker.launchd.log" "$LOG_DIR/worker.launchd.log.1" || true
if [ ! -f "$ENV_FILE" ]; then echo "FATAL: missing $ENV_FILE" >&2; exit 78; fi
if [ "$(stat -f '%Lp' "$ENV_FILE")" != "600" ]; then echo "FATAL: $ENV_FILE must be mode 600" >&2; exit 78; fi
set -a; . "$ENV_FILE"; set +a
export VH_DATA_DIR="$DATA_DIR" NODE_ENV=production VH_ROLE=worker
# Node comes from nvm on this host (there is no Homebrew node). VH_NODE_DIR in
# secrets/vh.env pins the exact bin dir, so a restart can never land on a
# different native ABI than better-sqlite3/sharp were built against.
NODE_DIR="${VH_NODE_DIR:-$(/bin/ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$NODE_DIR/node" ] || { echo "FATAL: no node at ${NODE_DIR:-<unset>}/node (set VH_NODE_DIR in secrets/vh.env)" >&2; exit 78; }
[ "$("$NODE_DIR/node" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "FATAL: node 24+ required, found $("$NODE_DIR/node" -v)" >&2; exit 78; }
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$APP_DIR"
exec node dist/worker/index.mjs
