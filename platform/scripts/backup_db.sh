#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup_db.sh - Create a timestamped compressed PostgreSQL backup
#
# Usage:
#   ./scripts/backup_db.sh
#   DATABASE_URL=postgresql://user:pass@host:5432/db BACKUP_DIR=/mnt/backups ./scripts/backup_db.sh
#
# Environment variables:
#   DATABASE_URL  - PostgreSQL connection string (required, or set defaults below)
#   BACKUP_DIR    - Directory to store backups (default: /backups)
#   PG_DUMP_OPTS  - Extra pg_dump options (default: empty)
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATABASE_URL="${DATABASE_URL:?DATABASE_URL environment variable must be set}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# Parse DATABASE_URL into components
# Format: postgresql://user:password@host:port/dbname
parse_db_url() {
    local url="$1"
    # Strip the scheme (postgresql:// or postgres://)
    local stripped="${url#*://}"
    # Extract user:password
    local userpass="${stripped%%@*}"
    DB_USER="${userpass%%:*}"
    DB_PASS="${userpass#*:}"
    # Extract host:port/dbname
    local hostportdb="${stripped#*@}"
    local hostport="${hostportdb%%/*}"
    DB_HOST="${hostport%%:*}"
    DB_PORT="${hostport#*:}"
    DB_NAME="${hostportdb#*/}"
    # Handle query params in dbname
    DB_NAME="${DB_NAME%%\?*}"
}

parse_db_url "$DATABASE_URL"

BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
if ! command -v pg_dump &>/dev/null; then
    echo "[ERROR] pg_dump not found. Install postgresql-client." >&2
    exit 1
fi

if ! command -v gzip &>/dev/null; then
    echo "[ERROR] gzip not found." >&2
    exit 1
fi

# Create backup directory if it doesn't exist
if [ ! -d "$BACKUP_DIR" ]; then
    echo "[INFO] Creating backup directory: $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
fi

# ---------------------------------------------------------------------------
# Execute backup
# ---------------------------------------------------------------------------
echo "[INFO] Starting backup of database '${DB_NAME}' on ${DB_HOST}:${DB_PORT}"
echo "[INFO] Backup file: ${BACKUP_FILE}"

export PGPASSWORD="$DB_PASS"

if pg_dump \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --no-owner \
    --no-privileges \
    ${PG_DUMP_OPTS:-} \
    | gzip > "$BACKUP_FILE"; then

    unset PGPASSWORD
    FILESIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
    echo "[SUCCESS] Backup completed: ${BACKUP_FILE} (${FILESIZE})"
else
    unset PGPASSWORD
    # Clean up partial file on failure
    rm -f "$BACKUP_FILE"
    echo "[ERROR] Backup failed for database '${DB_NAME}'" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Optional: prune old backups (keep last 7 days)
# ---------------------------------------------------------------------------
if [ "${BACKUP_RETENTION_DAYS:-}" != "" ]; then
    echo "[INFO] Pruning backups older than ${BACKUP_RETENTION_DAYS} days"
    find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +"$BACKUP_RETENTION_DAYS" -delete
    echo "[INFO] Pruning complete"
fi
