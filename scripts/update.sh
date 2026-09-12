#!/bin/bash
# Update the running installation: backup -> pull -> install -> test -> stop -> migrate -> build -> start.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"; UID_NUM="$(id -u)"; cd "$APP_DIR"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
[ -f "$DATA_DIR/secrets/vh.env" ] && { set -a; . "$DATA_DIR/secrets/vh.env"; set +a; }
[ -z "$(git status --porcelain)" ] || { echo "working tree dirty; commit or stash" >&2; exit 1; }
say "1/8 backup (rollback point)"; ./scripts/backup.sh --label pre-update --keep-forever
BEFORE="$(git rev-parse --short HEAD)"
say "2/8 git pull"; git pull --ff-only
say "3/8 install"; pnpm install --frozen-lockfile
say "4/8 typecheck + unit tests"; pnpm run typecheck && NODE_ENV=test pnpm exec vitest run tests/unit
say "5/8 stop worker, then web"
# SIGTERM alone triggers KeepAlive and can restart a process halfway through migration/build.
for service in worker web; do
  job="gui/$UID_NUM/net.machadolucas.virtual-home.$service"
  if launchctl print "$job" >/dev/null 2>&1; then launchctl bootout "$job"; fi
done
say "6/8 migrate"
if ! VH_ROLE=cli pnpm run db:migrate; then
  echo "MIGRATION FAILED. Restore: ./scripts/restore.sh $DATA_DIR/backups/daily/<pre-update>.tar.zst --force ; then git checkout $BEFORE && ./scripts/install-macmini.sh" >&2; exit 1
fi
say "7/8 build"; NEXT_PUBLIC_VH_TEST_HOOK=0 pnpm run build
say "8/8 start web, then worker"
launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/net.machadolucas.virtual-home.web.plist"
for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:${PORT:-3010}/api/health" >/dev/null 2>&1 && break; [ "$i" = 40 ] && { echo "web unhealthy after update" >&2; exit 1; }; sleep 1; done
launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/net.machadolucas.virtual-home.worker.plist"
say "updated $BEFORE -> $(git rev-parse --short HEAD)"
