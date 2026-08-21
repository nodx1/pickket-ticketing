#!/usr/bin/env bash
# PICKKET 백업 존재 검증 — 매일 1회. prod DB 백업(P0-B)이 구성되기 전에는 주 1회 미구성 리마인드만.
set -u
REPO="/home/oem/Development/active/pickket-v3"
OPS_ENV="$REPO/scripts/ops/ops.env"
STATE_DIR="$HOME/.local/state/pickket-ops"
ALERTS_LOG="$REPO/docs/ops/ALERTS.log"
mkdir -p "$STATE_DIR"
[ -f "$OPS_ENV" ] && . "$OPS_ENV"

note() { echo "[$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M')] $1" >> "$ALERTS_LOG"; }

if [ -z "${BACKUP_CHECK_PATH:-}" ]; then
  # 미구성 — 주 1회(월요일)만 리마인드. P0-B 카드 참조.
  # 로컬 백업 사용 시: ops.env 에 BACKUP_CHECK_PATH=/home/oem/storage/pickket-backups 설정(SSH 불필요).
  if [ "$(date +%u)" = "1" ]; then
    note "REMINDER: prod DB 백업 미구성(P0-B) — backup-check 는 대기 중"
    command -v notify-send >/dev/null && notify-send "PICKKET 백업" "prod DB 백업이 아직 미구성입니다 (보드 P0-B)" 2>/dev/null
  fi
  exit 0
fi

# 구성됨 — 26시간(1560분) 내 유효 백업 파일 존재·비어있지 않음 확인.
# BACKUP_CHECK_SSH 있으면 원격, 없으면 로컬(워크스테이션 HDD) 검사.
if [ -n "${BACKUP_CHECK_SSH:-}" ]; then
  latest=$(ssh -o ConnectTimeout=10 "$BACKUP_CHECK_SSH" \
    "find '$BACKUP_CHECK_PATH' -name '*.sql*' -mmin -1560 -size +1k | head -1" 2>/dev/null)
  loc="$BACKUP_CHECK_SSH:$BACKUP_CHECK_PATH"
else
  latest=$(find "$BACKUP_CHECK_PATH" -name '*.sql*' -mmin -1560 -size +1k 2>/dev/null | head -1)
  loc="(local) $BACKUP_CHECK_PATH"
fi
if [ -z "$latest" ]; then
  note "ALERT backup: 26시간 내 유효 백업 없음 ($loc)"
  command -v notify-send >/dev/null && notify-send -u critical "PICKKET 백업 실패" "26시간 내 백업 파일 없음" 2>/dev/null
  [ -n "${NTFY_TOPIC:-}" ] && curl -fsS -m 10 -H "Title: PICKKET 백업 실패" -H "Priority: high" \
    -d "26시간 내 백업 없음" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
else
  note "OK backup: $latest"
fi
exit 0
