#!/bin/bash
# Inspect and restart the launchd services in either mode, without sudo.
#
# Usage: services.sh status
#        services.sh restart [web|worker|all]   (default all)
#        services.sh hold | release             (system mode only)
#
# gui mode restarts with `launchctl kickstart -k gui/<uid>/<label>`. system mode (LaunchDaemons that
# run as this user, KeepAlive=true) restarts by stopping the pid and waiting for launchd's relaunch;
# `hold` stops web + worker and keeps them waiting on $VH_DATA_DIR/run/hold, `release` lets them
# start again. VH_LAUNCHD_DOMAIN and PORT are read from secrets/vh.env without sourcing it.
set -euo pipefail
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"; ENV_FILE="$DATA_DIR/secrets/vh.env"
# shellcheck source=lib/launchd.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/launchd.sh"
DOMAIN="$(vh_resolve_domain "$ENV_FILE")" || exit 78
PORT_NUM="$(vh_env_value "$ENV_FILE" PORT)"; PORT_NUM="${PORT_NUM:-3010}"
CMD="${1:-status}"; WHICH="${2:-all}"
case "$WHICH" in web|worker) SERVICES=("$WHICH");; all) SERVICES=(web worker);; *) echo "unknown service: $WHICH" >&2; exit 64;; esac
system_only() { [ "$DOMAIN" = system ] || { echo "'$CMD' is for VH_LAUNCHD_DOMAIN=system; in gui mode use launchctl bootout/bootstrap" >&2; exit 64; }; }

case "$CMD" in
  status)
    echo "domain: $DOMAIN"
    for svc in web worker backup; do
      target="$(vh_target "$DOMAIN" "$svc")"
      if vh_is_loaded "$target"; then
        echo "$target: state = $(vh_launchd_field "$target" state), pid = $(vh_launchd_field "$target" pid | grep . || echo -), pidfile = $(vh_read_pidfile "$DATA_DIR/run/$svc.pid" | grep . || echo -)"
      else
        echo "$target: not loaded"
      fi
    done
    if [ -e "$DATA_DIR/run/hold" ]; then echo "HELD by $DATA_DIR/run/hold"; fi
    ;;
  restart)
    for svc in "${SERVICES[@]}"; do
      if [ "$DOMAIN" = system ]; then
        vh_restart_by_pid "$DATA_DIR" system "$PORT_NUM" "$svc"
      else
        launchctl kickstart -k "$(vh_target gui "$svc")"
        echo "$svc: kickstarted"
      fi
    done
    ;;
  hold) system_only; vh_hold_and_stop "$DATA_DIR" system worker web ;;
  release) system_only; vh_release_and_wait "$DATA_DIR" system "$PORT_NUM" web worker ;;
  *) sed -n '2,11p' "$0" >&2; exit 64 ;;
esac
