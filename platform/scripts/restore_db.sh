#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# restore_db.sh - Restore PostgreSQL backup (.sql.gz) to target database
#
# Required env:
#   DATABASE_URL   - postgres connection string
#   BACKUP_FILE    - path to .sql.gz backup file
#   RESTORE_CONFIRM=YES_I_UNDERSTAND
#
# Optional env:
#   RESTORE_CLEAN=true|false (default: true)
# ---------------------------------------------------------------------------

DATABASE_URL="${DATABASE_URL:?DATABASE_URL environment variable must be set}"
BACKUP_FILE="${BACKUP_FILE:?BACKUP_FILE environment variable must be set}"
RESTORE_CONFIRM="${RESTORE_CONFIRM:-}"
RESTORE_CLEAN="${RESTORE_CLEAN:-true}"

if [[ "$RESTORE_CONFIRM" != "YES_I_UNDERSTAND" ]]; then
  echo "[ERROR] Restore is destructive. Set RESTORE_CONFIRM=YES_I_UNDERSTAND" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[ERROR] Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

for bin in psql gzip; do
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

parse_db_url "$DATABASE_URL"

echo "[INFO] Restoring into ${DB_NAME} on ${DB_HOST}:${DB_PORT}"
echo "[INFO] Backup file: ${BACKUP_FILE}"

export PGPASSWORD="$DB_PASS"

if [[ "$RESTORE_CLEAN" == "true" ]]; then
  echo "[INFO] Cleaning public schema..."
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
fi

echo "[INFO] Restoring SQL..."
gzip -cd "$BACKUP_FILE" | psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1

unset PGPASSWORD
echo "[SUCCESS] Restore completed."
