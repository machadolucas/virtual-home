#!/bin/bash
# Sample RSS/CPU of both processes: 10 min warm-up, then 30 samples at 60 s. Prints p50/p95/max per role.
set -euo pipefail
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"; WARMUP="${WARMUP_S:-600}"; SAMPLES="${SAMPLES:-30}"; INTERVAL="${INTERVAL_S:-60}"
OUT="$DATA_DIR/logs/resources-$(date +%Y%m%d-%H%M%S).tsv"; mkdir -p "$DATA_DIR/logs"
WEB_PID="$(pgrep -f 'next start' | head -1 || true)"; WRK_PID="$(pgrep -f 'dist/worker/index.mjs' | head -1 || true)"
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
awk -F'\t' 'NR>1 {v[$2][++n[$2]]=$4/1024}
  END { for (r in v) { c=n[r]; for(i=1;i<=c;i++) for(j=i+1;j<=c;j++) if(v[r][j]<v[r][i]){t=v[r][i];v[r][i]=v[r][j];v[r][j]=t}
        printf "%-7s n=%d p50=%.1f p95=%.1f max=%.1f -> alert at %.0f MB\n", r, c, v[r][int(c*0.5)+ (c%2)], v[r][int(c*0.95)>0?int(c*0.95):1], v[r][c], v[r][int(c*0.95)>0?int(c*0.95):1]*1.5 } }' "$OUT"
