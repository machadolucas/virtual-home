#!/bin/bash
# Update the running installation: backup -> pull -> install -> test -> stop -> migrate -> build -> start.
# Both launchd modes (VH_LAUNCHD_DOMAIN in secrets/vh.env, default gui; see scripts/lib/launchd.sh):
#   gui     boot the LaunchAgents out while migrating/building, bootstrap them again afterwards.
#   system  hold + stop the LaunchDaemons by pid (no sudo), release them afterwards.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"; UID_NUM="$(id -u)"; cd "$APP_DIR"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
# shellcheck source=lib/launchd.sh
. "$APP_DIR/scripts/lib/launchd.sh"
[ -f "$DATA_DIR/secrets/vh.env" ] && { set -a; . "$DATA_DIR/secrets/vh.env"; set +a; }
DOMAIN="$(vh_resolve_domain)" || exit 78
[ -z "$(git status --porcelain)" ] || { echo "working tree dirty; commit or stash" >&2; exit 1; }
if [ "$DOMAIN" = system ]; then
  # Refuse before touching anything: a hold that nothing would release, or two supervisors on one port.
  vh_require_loaded system web worker || exit 1
  for service in web worker backup; do
    if vh_is_loaded "$(vh_target gui "$service")"; then
      echo "$(vh_target gui "$service") is still loaded although VH_LAUNCHD_DOMAIN=system; boot it out first" >&2; exit 1
    fi
  done
fi
say "1/8 backup (rollback point)"; ./scripts/backup.sh --label pre-update --keep-forever
BEFORE="$(git rev-parse --short HEAD)"
say "2/8 git pull"; git pull --ff-only
say "3/8 install"; pnpm install --frozen-lockfile
say "4/8 typecheck + unit tests"; pnpm run typecheck && NODE_ENV=test pnpm exec vitest run tests/unit
if [ "$DOMAIN" = system ]; then
  say "5/8 hold, then stop worker and web"
  # KeepAlive=true makes launchd relaunch the wrappers at once; they wait on the hold. If anything
  # below fails they keep waiting, which is the system-mode equivalent of staying booted out.
  trap 'status=$?; [ "$status" = 0 ] || echo "Services are HELD by $DATA_DIR/run/hold. Fix the cause and re-run, or restore (docs/operations.md). ./scripts/services.sh release starts whatever is built now." >&2' EXIT
  vh_hold_and_stop "$DATA_DIR" system worker web
else
  say "5/8 stop worker, then web"
  # SIGTERM alone triggers KeepAlive and can restart a process halfway through migration/build.
  for service in worker web; do
    job="gui/$UID_NUM/net.machadolucas.virtual-home.$service"
    if launchctl print "$job" >/dev/null 2>&1; then launchctl bootout "$job"; fi
  done
fi
say "6/8 migrate"
if ! VH_ROLE=cli pnpm run db:migrate; then
  echo "MIGRATION FAILED. Restore: ./scripts/restore.sh $DATA_DIR/backups/daily/<pre-update>.tar.zst --force ; then git checkout $BEFORE && ./scripts/install-macmini.sh" >&2; exit 1
fi
say "7/8 build"; NEXT_PUBLIC_VH_TEST_HOOK=0 pnpm run build
if [ "$DOMAIN" = system ]; then
  say "8/8 release web and worker"
  trap - EXIT
  vh_release_and_wait "$DATA_DIR" system "${PORT:-3010}" web worker || { echo "services unhealthy after update" >&2; exit 1; }
else
  say "8/8 start web, then worker"
  launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/net.machadolucas.virtual-home.web.plist"
  for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:${PORT:-3010}/api/health" >/dev/null 2>&1 && break; [ "$i" = 40 ] && { echo "web unhealthy after update" >&2; exit 1; }; sleep 1; done
  launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/net.machadolucas.virtual-home.worker.plist"
fi
say "updated $BEFORE -> $(git rev-parse --short HEAD)"
