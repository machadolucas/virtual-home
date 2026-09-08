#!/bin/bash
# Sample RSS/CPU of both processes: 10 min warm-up, then 30 samples at 60 s. Prints p50/p95/max per role.
set -euo pipefail
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"; WARMUP="${WARMUP_S:-600}"; SAMPLES="${SAMPLES:-30}"; INTERVAL="${INTERVAL_S:-60}"
OUT="$DATA_DIR/logs/resources-$(date +%Y%m%d-%H%M%S).tsv"; mkdir -p "$DATA_DIR/logs"
# `next start` spawns the real server as a child named "next-server (vX)"; measure that, not the launcher.
# Several Next apps run on this host, so `pgrep -f next-server` can match a
# different one. Resolve our own web process by the port it listens on.
PORT="${PORT:-$(sed -n 's/^PORT=//p' "$DATA_DIR/secrets/vh.env" 2>/dev/null | tail -1)}"; PORT="${PORT:-3010}"
WEB_PID="${VH_WEB_PID:-$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -1)}"
[ -n "$WEB_PID" ] || WEB_PID="$(pgrep -f 'next-server' | head -1 || true)"
WRK_PID="$(pgrep -f 'dist/worker/index.mjs' | head -1 || true)"
[ -n "$WEB_PID" ] && [ -n "$WRK_PID" ] || { echo "processes not running (web=$WEB_PID worker=$WRK_PID)" >&2; exit 1; }
echo "warm-up ${WARMUP}s: browse the app, open the 3D model, upload a photo, leave a tab open"; sleep "$WARMUP"
printf 'ts\trole\tpid\trss_kb\tcpu_pct\n' > "$OUT"
for i in $(seq 1 "$SAMPLES"); do
  for pair in "web:$WEB_PID" "worker:$WRK_PID"; do
    role="${pair%%:*}"; pid="${pair##*:}"
    read -r rss cpu <<<"$(ps -o rss=,%cpu= -p "$pid" | awk '{print $1, $2}')"
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date +%s)" "$role" "$pid" "${rss:-0}" "${cpu:-0}" >> "$OUT"
  done
  sleep "$INTERVAL"
done
echo "--- summary (RSS MB) --- $OUT"
python3 - "$OUT" <<'PY'
import csv, sys
from collections import defaultdict
rows = list(csv.DictReader(open(sys.argv[1]), delimiter="\t"))
by = defaultdict(list)
for r in rows: by[r["role"]].append(float(r["rss_kb"]) / 1024)
for role, v in by.items():
    v.sort(); n = len(v); p50 = v[n // 2]; p95 = v[min(n - 1, int(n * 0.95))]
    print(f"{role:7s} n={n} p50={p50:.1f} p95={p95:.1f} max={v[-1]:.1f} -> alert at {p95 * 1.5:.0f} MB")
PY
