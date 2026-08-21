#!/usr/bin/env bash
# PICKKET prod DB 백업 (P0-B) — pg_dump → 워크스테이션 1.8T HDD.
#
# 대상 디스크: /home/oem/storage (sda, X99와 별개 물리디스크·별개 머신 = 오프박스).
# 연결정보는 scripts/ops/backup.env (gitignore) 에서 로드 — 커밋 금지.
# 실행: 크론(매일 03:10, install-crontab.sh) 또는 수동. prod DB 접근 필요(대표 승인 후).
#
# ⚠️ 덤프에는 고객 PII 포함 → 파일 권한 600, 디렉토리 700. 오프사이트/암호화는 tier-2(런북 참조).
set -euo pipefail

REPO="/home/oem/Development/active/pickket-v3"
ENVF="$REPO/scripts/ops/backup.env"
DEST="${BACKUP_DEST:-/home/oem/storage/pickket-backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
ALERTS_LOG="$REPO/docs/ops/ALERTS.log"

note() { echo "[$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M')] backup-db: $1" >> "$ALERTS_LOG" 2>/dev/null || true; }

command -v pg_dump >/dev/null 2>&1 || { echo "FATAL: pg_dump 없음 (apt install postgresql-client)"; note "FATAL pg_dump 미설치"; exit 3; }
[ -f "$ENVF" ] || { echo "FATAL: $ENVF 없음 — backup.env.example 참고해 연결정보 채울 것"; note "FATAL backup.env 없음"; exit 2; }
# shellcheck disable=SC1090
. "$ENVF"
# 필요 env: PG_V2_URL, PG_GO_URL  (형식: postgresql://user:pass@host:port/dbname)

mkdir -p "$DEST"; chmod 700 "$DEST"
STAMP=$(TZ=Asia/Seoul date +%Y%m%d-%H%M)
fail=0

dump_one() {
  local name="$1" url="${2:-}"
  if [ -z "$url" ]; then echo "SKIP $name (URL 미설정)"; return; fi
  local out="$DEST/${name}-${STAMP}.sql.gz"
  if pg_dump --no-owner --no-privileges --format=plain "$url" 2>/dev/null | gzip -6 > "$out.tmp"; then
    if gzip -t "$out.tmp" 2>/dev/null && [ "$(stat -c%s "$out.tmp" 2>/dev/null || echo 0)" -gt 1024 ]; then
      mv "$out.tmp" "$out"; chmod 600 "$out"
      echo "OK   $name → $out ($(du -h "$out" | cut -f1))"
    else
      echo "FAIL $name 무결성(빈/손상 덤프)"; rm -f "$out.tmp"; fail=1
    fi
  else
    echo "FAIL $name pg_dump 실패"; rm -f "$out.tmp"; fail=1
  fi
}

dump_one "v2" "${PG_V2_URL:-}"
dump_one "go" "${PG_GO_URL:-}"

# 로테이션 — RETAIN_DAYS 초과분 삭제
find "$DEST" -maxdepth 1 -name '*.sql.gz' -mtime +"$RETAIN_DAYS" -delete 2>/dev/null || true

if [ "$fail" = "0" ]; then
  date +%s > "$DEST/.last-backup"   # backup-check.sh 가 읽는 최신 백업 마커
  note "OK 백업 완료 ($DEST)"
else
  note "ALERT 백업 일부/전체 실패 — 로그 확인"
fi
exit "$fail"
