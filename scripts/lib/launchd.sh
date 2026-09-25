# shellcheck shell=bash
# Shared launchd helpers. Sourced by the launchd wrappers, install-macmini.sh, update.sh,
# restore.sh and services.sh; defines functions only and changes no shell options.
#
# Two supervision modes, chosen by VH_LAUNCHD_DOMAIN in secrets/vh.env:
#
#   gui     (default) per-user LaunchAgents in ~/Library/LaunchAgents, loaded into gui/<uid>.
#           No sudo anywhere, but they run only while the user has a GUI login session: if the
#           session ends (logout, a WindowServer crash) the app goes down until someone logs in.
#   system  LaunchDaemons in /Library/LaunchDaemons that run as the app user (UserName/GroupName).
#           They start at boot and survive the loss of the login session. Installing them needs
#           sudo once; after that nothing here does. `launchctl print system/<label>` is readable
#           unprivileged, the processes belong to the app user, and KeepAlive=true makes launchd
#           relaunch whatever we kill. While an update or restore works, a hold file
#           ($VH_DATA_DIR/run/hold) keeps the relaunched wrappers waiting instead of starting.
#
# Every wrapper writes $VH_DATA_DIR/run/<role>.pid just before it execs node (exec keeps the pid,
# so it is the pid launchd supervises). A pidfile therefore means "node started", never "a
# wrapper is waiting on the hold".

VH_LABEL_PREFIX="net.machadolucas.virtual-home"

vh_label() { printf '%s.%s\n' "$VH_LABEL_PREFIX" "$1"; }

# vh_env_value FILE KEY — the last KEY=value in a dotenv file, read WITHOUT sourcing it (restore.sh
# and services.sh must not pull BETTER_AUTH_SECRET/HA_TOKEN into their environment). Strips a
# trailing " # comment", surrounding quotes and whitespace. Prints nothing when absent.
vh_env_value() {
  [ -r "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -1 |
    sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# vh_resolve_domain [ENV_FILE] — prints gui or system. VH_LAUNCHD_DOMAIN from the environment wins
# (callers that source vh.env have already exported it); otherwise it is read from ENV_FILE.
# Anything else is a configuration error (exit status 78, the app's config-error convention).
vh_resolve_domain() {
  local domain="${VH_LAUNCHD_DOMAIN:-}"
  if [ -z "$domain" ] && [ -n "${1:-}" ]; then domain="$(vh_env_value "$1" VH_LAUNCHD_DOMAIN)"; fi
  case "${domain:-gui}" in
    gui|system) printf '%s\n' "${domain:-gui}" ;;
    *) echo "FATAL: VH_LAUNCHD_DOMAIN must be 'gui' or 'system', got '$domain'" >&2; return 78 ;;
  esac
}

# vh_target DOMAIN SERVICE — the launchctl service target, e.g. gui/501/<label> or system/<label>.
vh_target() {
  if [ "$1" = system ]; then printf 'system/%s\n' "$(vh_label "$2")"
  else printf 'gui/%s/%s\n' "$(id -u)" "$(vh_label "$2")"; fi
}

vh_is_loaded() { launchctl print "$1" >/dev/null 2>&1; }

# vh_launchd_field TARGET FIELD — a top-level field of `launchctl print` (pid, state, username…).
vh_launchd_field() {
  local tab=$'\t'
  launchctl print "$1" 2>/dev/null | sed -n "s/^${tab}$2 = //p" | head -1
}

vh_pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

vh_read_pidfile() {
  local pid=""
  [ -f "$1" ] && pid="$(tr -dc '0-9' <"$1")"
  printf '%s\n' "$pid"
}

# vh_service_pid DOMAIN SERVICE DATA_DIR — the live pid of a job: launchd's view first, then the
# wrapper's pidfile. Prints nothing when the job has no live process.
vh_service_pid() {
  local pid
  pid="$(vh_launchd_field "$(vh_target "$1" "$2")" pid)"
  case "$pid" in ''|*[!0-9]*) pid="$(vh_read_pidfile "$3/run/$2.pid")" ;; esac
  if vh_pid_alive "$pid"; then printf '%s\n' "$pid"; fi
}

# vh_wait_exit PID SECONDS — true once PID is gone, false if it is still alive after SECONDS.
vh_wait_exit() {
  local i
  for ((i = 0; i < $2 * 5; i++)); do vh_pid_alive "$1" || return 0; sleep 0.2; done
  ! vh_pid_alive "$1"
}

# vh_stop_pid SERVICE PID — SIGTERM, wait, then SIGKILL as a last resort.
vh_stop_pid() {
  local timeout="${VH_STOP_TIMEOUT_S:-30}"
  kill -TERM "$2" 2>/dev/null || true
  vh_wait_exit "$2" "$timeout" && return 0
  echo "$1: pid $2 still alive ${timeout}s after SIGTERM; sending SIGKILL" >&2
  kill -KILL "$2" 2>/dev/null || true
  vh_wait_exit "$2" 5 || { echo "FATAL: $1 (pid $2) will not exit" >&2; return 1; }
}

# vh_require_loaded DOMAIN SERVICE... — fail unless every job is loaded in DOMAIN.
vh_require_loaded() {
  local domain="$1" svc missing=0; shift
  for svc in "$@"; do
    vh_is_loaded "$(vh_target "$domain" "$svc")" && continue
    echo "FATAL: $(vh_target "$domain" "$svc") is not loaded" >&2; missing=1
  done
  [ "$missing" = 0 ] || {
    echo "Install the LaunchDaemons first: ./scripts/install-macmini.sh prints the sudo lines (docs/deploy-mac-mini.md)." >&2
    return 1
  }
}

# vh_hold_and_stop DATA_DIR DOMAIN SERVICE... — system mode's replacement for `launchctl bootout`:
# create the hold file, then stop each service by pid (no sudo) and wait for it to exit. launchd
# relaunches the wrapper at once (KeepAlive=true) and the wrapper waits on the hold.
vh_hold_and_stop() {
  local data="$1" domain="$2" svc pid; shift 2
  mkdir -p "$data/run"
  : >"$data/run/hold"
  for svc in "$@"; do
    pid="$(vh_service_pid "$domain" "$svc" "$data")"
    rm -f "$data/run/$svc.pid"
    if [ -z "$pid" ]; then echo "$svc: no running process"; continue; fi
    vh_stop_pid "$svc" "$pid" || return 1
    echo "$svc: stopped pid $pid; held by $data/run/hold"
  done
}

# vh_service_started DOMAIN SERVICE DATA_DIR — node has started: a pidfile names a live process, and
# (when launchd reports one) it is the pid launchd supervises.
vh_service_started() {
  local pid lpid
  pid="$(vh_read_pidfile "$3/run/$2.pid")"
  vh_pid_alive "$pid" || return 1
  lpid="$(vh_launchd_field "$(vh_target "$1" "$2")" pid)"
  [ -z "$lpid" ] || [ "$lpid" = "$pid" ]
}

vh_web_healthy() { curl -fsS -m 5 "http://127.0.0.1:$1/api/health" >/dev/null 2>&1; }

# vh_wait_started DATA_DIR DOMAIN PORT SERVICE... — wait for every service's new pid, then for the
# web health endpoint when web is among them. VH_START_TIMEOUT_S (default 120) bounds the whole wait.
vh_wait_started() {
  local data="$1" domain="$2" port="$3" svc; shift 3
  local timeout="${VH_START_TIMEOUT_S:-120}" start=$SECONDS
  for svc in "$@"; do
    until vh_service_started "$domain" "$svc" "$data"; do
      if [ $((SECONDS - start)) -ge "$timeout" ]; then
        echo "FATAL: $svc did not start within ${timeout}s; see $data/logs/$svc.launchd.log*" >&2; return 1
      fi
      sleep 0.5
    done
    echo "$svc: running (pid $(vh_read_pidfile "$data/run/$svc.pid"))"
  done
  case " $* " in *" web "*) ;; *) return 0 ;; esac
  until vh_web_healthy "$port"; do
    if [ $((SECONDS - start)) -ge "$timeout" ]; then
      echo "FATAL: web did not answer http://127.0.0.1:$port/api/health within ${timeout}s" >&2; return 1
    fi
    sleep 1
  done
  echo "web: healthy on 127.0.0.1:$port"
}

# vh_release_and_wait DATA_DIR DOMAIN PORT SERVICE... — remove the hold and wait for the services.
vh_release_and_wait() {
  local data="$1" domain="$2" port="$3"; shift 3
  vh_require_loaded "$domain" "$@" || return 1
  rm -f "$data/run/hold"
  vh_wait_started "$data" "$domain" "$port" "$@"
}

# vh_restart_by_pid DATA_DIR DOMAIN PORT SERVICE — system mode's `kickstart -k`, without sudo.
vh_restart_by_pid() {
  local data="$1" domain="$2" port="$3" svc="$4" pid
  if [ -e "$data/run/hold" ]; then
    echo "FATAL: $data/run/hold exists (an update or restore is running, or aborted); release it first" >&2; return 1
  fi
  vh_require_loaded "$domain" "$svc" || return 1
  pid="$(vh_service_pid "$domain" "$svc" "$data")"
  rm -f "$data/run/$svc.pid"
  if [ -n "$pid" ]; then vh_stop_pid "$svc" "$pid" || return 1; fi
  vh_wait_started "$data" "$domain" "$port" "$svc"
}

# --- used by the wrappers ---------------------------------------------------------------------

# vh_wait_for_hold DATA_DIR ROLE — block (polling every VH_HOLD_POLL_S seconds, default 2) while
# the hold file exists.
vh_wait_for_hold() {
  local hold="$1/run/hold"
  [ -e "$hold" ] || return 0
  echo "$(date '+%Y-%m-%d %H:%M:%S') $2: held by $hold; waiting"
  while [ -e "$hold" ]; do sleep "${VH_HOLD_POLL_S:-2}"; done
  echo "$(date '+%Y-%m-%d %H:%M:%S') $2: hold released; starting"
}

# vh_write_pidfile DATA_DIR ROLE — record this shell's pid, which the following exec hands to node.
vh_write_pidfile() {
  mkdir -p "$1/run"
  echo "$$" >"$1/run/$2.pid.tmp" && mv -f "$1/run/$2.pid.tmp" "$1/run/$2.pid"
}

# --- used by install-macmini.sh -----------------------------------------------------------------

# vh_render_plist TEMPLATE DEST APP_DIR DATA_DIR DOMAIN JOB — fill the template. System mode adds
# UserName/GroupName and HOME/USER/LOGNAME for the current user (the wrappers resolve Node from
# $HOME), and makes web/worker KeepAlive=true so a stop-by-pid is always followed by a relaunch.
# The backup job keeps its calendar schedule.
vh_render_plist() {
  local src="$1" dst="$2" app="$3" data="$4" domain="$5" job="$6" user group
  sed -e "s|__APP_DIR__|$app|g" -e "s|__DATA_DIR__|$data|g" "$src" >"$dst"
  if [ "$domain" = system ]; then
    user="$(id -un)"; group="$(id -gn)"
    plutil -replace UserName -string "$user" "$dst"
    plutil -replace GroupName -string "$group" "$dst"
    plutil -replace EnvironmentVariables.HOME -string "$HOME" "$dst"
    plutil -replace EnvironmentVariables.USER -string "$user" "$dst"
    plutil -replace EnvironmentVariables.LOGNAME -string "$user" "$dst"
    if [ "$job" != backup ]; then plutil -replace KeepAlive -bool true "$dst"; fi
  fi
  plutil -lint "$dst" >/dev/null
}
