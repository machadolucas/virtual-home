#!/bin/bash
# Restore a backup archive into an EMPTY data directory (or --force onto the live one after stopping services).
# Usage: restore.sh <archive.tar.zst> [--target DIR] [--force]
set -euo pipefail
ARCHIVE="${1:?usage: restore.sh <archive.tar.zst> [--target DIR] [--force]}"; shift
TARGET="${VH_DATA_DIR:-$HOME/virtual-home-data}"; FORCE=0
while [ $# -gt 0 ]; do case "$1" in
  --target) TARGET="$2"; shift 2;;
  --force) FORCE=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done
ZSTD="$(command -v zstd || true)"; SQLITE="$(command -v sqlite3 || echo /usr/bin/sqlite3)"
[ -n "$ZSTD" ] || { echo "FATAL: zstd not found" >&2; exit 1; }
[ -f "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE" >&2; exit 1; }
if [ -f "$ARCHIVE.sha256" ]; then
  echo "$(cat "$ARCHIVE.sha256")  $ARCHIVE" | shasum -a 256 -c - >/dev/null || { echo "FATAL: checksum mismatch" >&2; exit 1; }
fi
if [ -e "$TARGET/db/app.db" ] && [ "$FORCE" = "0" ]; then
  echo "FATAL: $TARGET/db/app.db exists. Use --force (stop the services first!) or --target <empty dir>." >&2; exit 1
fi
if [ "$FORCE" = "1" ]; then
  UID_NUM="$(id -u)"
  for j in web worker; do launchctl kill SIGTERM "gui/$UID_NUM/net.machadolucas.virtual-home.$j" 2>/dev/null || true; done
  sleep 3
fi
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
"$ZSTD" -dc "$ARCHIVE" | tar -xf - -C "$WORK"
SRC="$(find "$WORK" -maxdepth 1 -type d -name 'vh-*' | head -1)"
[ -n "$SRC" ] || { echo "FATAL: unexpected archive layout" >&2; exit 1; }
echo "--- manifest ---"; cat "$SRC/manifest.json"; echo
"$SQLITE" "$SRC/app.db" 'PRAGMA integrity_check;' | head -1 | grep -qx ok || { echo "FATAL: restored DB failed integrity_check" >&2; exit 1; }
FK="$("$SQLITE" "$SRC/app.db" 'PRAGMA foreign_key_check;' | head -5)"; [ -z "$FK" ] || { echo "WARNING: foreign_key_check reported:"; echo "$FK"; }
mkdir -p "$TARGET"/{db,attachments,model,backups/daily,backups/weekly,exports,secrets,logs,tmp}
chmod 700 "$TARGET" "$TARGET/secrets"
cp "$SRC/app.db" "$TARGET/db/app.db"; rm -f "$TARGET/db/app.db-wal" "$TARGET/db/app.db-shm"
rsync -a --delete "$SRC/attachments/" "$TARGET/attachments/"
rsync -a --delete "$SRC/model/" "$TARGET/model/"
# Older archives predate reversible quarantine. Do not erase unrelated recovery files.
mkdir -p "$TARGET/quarantine"
[ ! -d "$SRC/quarantine" ] || rsync -a "$SRC/quarantine/" "$TARGET/quarantine/"
if [ ! -f "$TARGET/secrets/vh.env" ] && [ -f "$SRC/vh.env.redacted" ]; then
  cp "$SRC/vh.env.redacted" "$TARGET/secrets/vh.env"; chmod 600 "$TARGET/secrets/vh.env"
  echo "!! vh.env restored WITHOUT secrets: set BETTER_AUTH_SECRET and HA_TOKEN before starting"
fi
echo "--- report ---"
"$SQLITE" "$TARGET/db/app.db" "SELECT 'users', count(*) FROM user UNION ALL SELECT 'sessions', count(*) FROM session UNION ALL SELECT 'attachments', count(*) FROM attachment;" 2>/dev/null || true
echo "attachment files: $(find "$TARGET/attachments" -type f | wc -l | tr -d ' ')"
echo "restore complete into $TARGET"
