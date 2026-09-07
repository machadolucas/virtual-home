#!/bin/bash
# Consistent snapshot of database + attachments + model packages + redacted config.
# Usage: backup.sh [--label nightly|pre-migration|pre-update|manual] [--keep-forever]
set -euo pipefail
DATA_DIR="${VH_DATA_DIR:-$HOME/virtual-home-data}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="nightly"; KEEP_FOREVER=0
while [ $# -gt 0 ]; do case "$1" in
  --label) LABEL="$2"; shift 2;;
  --keep-forever) KEEP_FOREVER=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done
ZSTD="$(command -v zstd || true)"; SQLITE="$(command -v sqlite3 || echo /usr/bin/sqlite3)"
[ -n "$ZSTD" ] || { echo "FATAL: zstd not found (brew install zstd)" >&2; exit 1; }
[ -f "$DATA_DIR/db/app.db" ] || { echo "FATAL: no database at $DATA_DIR/db/app.db" >&2; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"; NAME="vh-${TS}-${LABEL}"
STAGE="$DATA_DIR/tmp/$NAME"; OUT_DIR="$DATA_DIR/backups/daily"; OUT="$OUT_DIR/$NAME.tar.zst"
mkdir -p "$STAGE" "$OUT_DIR" "$DATA_DIR/backups/weekly"
trap 'rm -rf "$STAGE"' EXIT

# 1. SQLite online backup (WAL-safe) + integrity check
"$SQLITE" "$DATA_DIR/db/app.db" ".backup '$STAGE/app.db'"
"$SQLITE" "$STAGE/app.db" 'PRAGMA integrity_check;' | head -1 | grep -qx ok || { echo "FATAL: snapshot failed integrity_check" >&2; exit 1; }
SCHEMA_HASH="$("$SQLITE" "$STAGE/app.db" 'SELECT COALESCE((SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1),"none");' 2>/dev/null || echo none)"
USERS="$("$SQLITE" "$STAGE/app.db" 'SELECT count(*) FROM user;' 2>/dev/null || echo 0)"
ATT="$("$SQLITE" "$STAGE/app.db" 'SELECT count(*) FROM attachment;' 2>/dev/null || echo 0)"

# 2. payload
[ -d "$DATA_DIR/attachments" ] && cp -R "$DATA_DIR/attachments" "$STAGE/attachments" || mkdir -p "$STAGE/attachments"
[ -d "$DATA_DIR/model" ] && cp -R "$DATA_DIR/model" "$STAGE/model" || mkdir -p "$STAGE/model"

# 3. config WITHOUT secrets
if [ -f "$DATA_DIR/secrets/vh.env" ]; then
  sed -E 's/^(BETTER_AUTH_SECRET|HA_TOKEN)=.*/\1=<REDACTED>/' "$DATA_DIR/secrets/vh.env" > "$STAGE/vh.env.redacted"
fi
cat > "$STAGE/SECRETS-README.txt" <<'TXT'
BETTER_AUTH_SECRET and HA_TOKEN are deliberately NOT in this archive.
Restoring without them: generate a new BETTER_AUTH_SECRET (all sessions are invalidated; sign in
again) and create a new Home Assistant long-lived token. Keep the real values in a password manager.
TXT

# 4. manifest
cat > "$STAGE/manifest.json" <<JSON
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "label": "$LABEL",
  "appVersion": "$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)",
  "gitCommit": "$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "schemaHash": "$SCHEMA_HASH",
  "modelCurrent": $(cat "$DATA_DIR/model/current.json" 2>/dev/null || echo null),
  "sqliteVersion": "$("$SQLITE" --version | awk '{print $1}')",
  "host": "$(scutil --get LocalHostName 2>/dev/null || hostname)",
  "rowCounts": { "users": $USERS, "attachments": $ATT },
  "excludes": ["BETTER_AUTH_SECRET", "HA_TOKEN", "logs/", "backups/", "tmp/", "exports/"]
}
JSON

# 5. archive: PIPE through zstd (bsdtar --zstd exits 0 but barely compresses on macOS)
STAGED_BYTES="$(du -sk "$STAGE" | awk '{print $1*1024}')"
tar -cf - -C "$DATA_DIR/tmp" "$NAME" | "$ZSTD" -19 -T0 -q -o "$OUT"
chmod 600 "$OUT"
shasum -a 256 "$OUT" | awk '{print $1}' > "$OUT.sha256"

# 6. verify readability
"$ZSTD" -dc "$OUT" | tar -tf - >/dev/null || { echo "FATAL: archive unreadable" >&2; rm -f "$OUT" "$OUT.sha256"; exit 1; }
OUT_BYTES="$(stat -f%z "$OUT")"

# 7. weekly promotion (hardlink)
[ "$(date +%u)" = "7" ] && ln -f "$OUT" "$DATA_DIR/backups/weekly/$NAME.tar.zst" || true

# 8. retention (never deletes --keep-forever labels: pre-migration/pre-update/manual)
if [ "$KEEP_FOREVER" = "0" ]; then
  ls -1t "$OUT_DIR"/vh-*-nightly.tar.zst 2>/dev/null | tail -n +$((${VH_BACKUP_RETAIN_DAILY:-14}+1)) | while read -r f; do rm -f "$f" "$f.sha256"; done
  ls -1t "$DATA_DIR/backups/weekly"/vh-*.tar.zst 2>/dev/null | tail -n +$((${VH_BACKUP_RETAIN_WEEKLY:-8}+1)) | while read -r f; do rm -f "$f" "$f.sha256"; done
fi

# 9. record the run (table may not exist on very first run)
"$SQLITE" "$DATA_DIR/db/app.db" "INSERT INTO backup_run (id, created_at_ms, label, path, bytes, ok) VALUES (lower(hex(randomblob(16))), $(date +%s)000, '$LABEL', '$OUT', $OUT_BYTES, 1);" 2>/dev/null || true
echo "backup ok: $OUT ($OUT_BYTES bytes from $STAGED_BYTES staged)"
