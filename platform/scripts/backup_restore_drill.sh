#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# backup_restore_drill.sh
# Creates a fresh backup and restores it into a temporary drill DB to verify:
# - backup artifact integrity
# - restore path validity
# - basic table presence after restore
#
# Required env:
#   DATABASE_URL
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL environment variable must be set}"
DRILL_PREFIX="${DRILL_PREFIX:-drill}"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/security-reports/backups}"

for bin in createdb dropdb psql pg_dump gzip; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[ERROR] missing command: $bin" >&2
    exit 1
  fi
done

parse_db_url() {
  local url="$1"
  local stripped="${url#*://}"
  local userpass="${stripped%%@*}"
  DB_USER="${userpass%%:*}"
  DB_PASS="${userpass#*:}"
  local hostportdb="${stripped#*@}"
  local hostport="${hostportdb%%/*}"
  DB_HOST="${hostport%%:*}"
  DB_PORT="${hostport#*:}"
  DB_NAME="${hostportdb#*/}"
  DB_NAME="${DB_NAME%%\?*}"
}

replace_db_name() {
  local url="$1"
  local new_name="$2"
  echo "$url" | sed -E "s#(postgres(ql)?://[^/]+/)[^?]+#\\1${new_name}#"
}

parse_db_url "$DATABASE_URL"

mkdir -p "$BACKUP_DIR"
start_ts="$(date +%s)"
stamp="$(date +%Y%m%d_%H%M%S)"
drill_db="${DB_NAME}_${DRILL_PREFIX}_${stamp}"
drill_url="$(replace_db_name "$DATABASE_URL" "$drill_db")"

echo "[INFO] Step 1/4 - Creating backup"
(
  cd "$ROOT_DIR"
  DATABASE_URL="$DATABASE_URL" BACKUP_DIR="$BACKUP_DIR" ./scripts/backup_db.sh
)

latest_backup="$(ls -1t "$BACKUP_DIR"/"${DB_NAME}"_*.sql.gz | head -n 1)"
if [[ -z "${latest_backup:-}" ]]; then
  echo "[ERROR] backup file not generated." >&2
  exit 1
fi

echo "[INFO] Step 2/4 - Creating drill DB: ${drill_db}"
export PGPASSWORD="$DB_PASS"
createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$drill_db"

echo "[INFO] Step 3/4 - Restoring backup into drill DB"
(
  cd "$ROOT_DIR"
  DATABASE_URL="$drill_url" \
  BACKUP_FILE="$latest_backup" \
  RESTORE_CONFIRM="YES_I_UNDERSTAND" \
  RESTORE_CLEAN="true" \
  ./scripts/restore_db.sh
)

echo "[INFO] Step 4/4 - Validating restored schema"
table_count="$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$drill_db" -Atc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")"

if [[ "${table_count}" -le 0 ]]; then
  echo "[ERROR] drill restore validation failed: no public tables found." >&2
  dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$drill_db" || true
  unset PGPASSWORD
  exit 1
fi

echo "[INFO] Cleaning up drill DB"
dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$drill_db"
unset PGPASSWORD

elapsed="$(( $(date +%s) - start_ts ))"
echo "[SUCCESS] Backup/restore drill passed in ${elapsed}s"
echo "          backup file: ${latest_backup}"
