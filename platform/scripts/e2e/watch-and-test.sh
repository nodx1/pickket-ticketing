#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────
# Pickket 로컬 개발 자동 감시
#
# 개발 중 파일이 변경되면 자동으로:
# 1. 사이트 크롤러 실행 (콘솔 에러, 404, 깨진 링크 탐지)
# 2. 결과를 텔레그램으로 보고
#
# 사용법:
#   pnpm watch:test          # consumer dev 서버가 이미 실행 중이어야 함
#
# 필수:
#   - inotifywait (sudo apt install inotify-tools)
#   - consumer dev 서버 실행 중 (localhost:3020)
#
# 환경변수:
#   TELEGRAM_BOT_TOKEN  — BotFather 토큰
#   TELEGRAM_CHAT_ID    — 보고할 채팅 ID
# ────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONSUMER_DIR="$PROJECT_ROOT/apps/consumer"
NOTIFY_SCRIPT="$SCRIPT_DIR/notify-telegram.sh"

# 색상
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# inotifywait 확인
if ! command -v inotifywait &> /dev/null; then
  echo -e "${RED}❌ inotifywait 없음. 설치: sudo apt install inotify-tools${NC}"
  exit 1
fi

# dev 서버 확인
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:3020 | grep -q "200\|302\|304"; then
  echo -e "${YELLOW}⚠️  localhost:3020 응답 없음. 'pnpm dev:consumer' 먼저 실행하세요.${NC}"
  echo -e "${YELLOW}   대기 중... (서버 시작되면 자동 진행)${NC}"
  while ! curl -s -o /dev/null http://localhost:3020 2>/dev/null; do
    sleep 5
  done
  echo -e "${GREEN}✅ dev 서버 감지됨${NC}"
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Pickket 로컬 자동 감시 시작${NC}"
echo -e "${GREEN}  감시 대상: apps/consumer/src/${NC}"
echo -e "${GREEN}  파일 변경 → 크롤러 실행 → 텔레그램 보고${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 쿨다운: 마지막 테스트 후 최소 60초 대기
LAST_RUN=0
COOLDOWN=60

run_crawl_test() {
  local NOW
  NOW=$(date +%s)
  local DIFF=$((NOW - LAST_RUN))

  if [ "$DIFF" -lt "$COOLDOWN" ]; then
    echo -e "${YELLOW}⏳ 쿨다운 중... ($((COOLDOWN - DIFF))초 후 실행 가능)${NC}"
    return
  fi

  LAST_RUN=$NOW
  echo ""
  echo -e "${YELLOW}🔍 파일 변경 감지 — 크롤러 실행 시작 ($(date '+%H:%M:%S'))${NC}"

  # Next.js HMR 안정화 대기
  sleep 5

  cd "$CONSUMER_DIR"

  # 크롤러 실행
  local RESULT_DIR
  RESULT_DIR=$(mktemp -d)

  if npx playwright test site-crawler --reporter=json --output="$RESULT_DIR" 2>/dev/null; then
    echo -e "${GREEN}✅ 크롤러 통과 — 에러 없음 ($(date '+%H:%M:%S'))${NC}"

    # 텔레그램 보고 (성공)
    if [ -f "$RESULT_DIR/crawl-report.json" ]; then
      bash "$NOTIFY_SCRIPT" "$RESULT_DIR/crawl-report.json" "pass"
    else
      # JSON 없으면 간단 알림
      bash "$NOTIFY_SCRIPT" "" "pass"
    fi
  else
    echo -e "${RED}❌ 크롤러 실패 — 에러 발견 ($(date '+%H:%M:%S'))${NC}"

    # 아티팩트에서 JSON 찾기
    local JSON_FILE
    JSON_FILE=$(find "$RESULT_DIR" -name "crawl-report.json" 2>/dev/null | head -1)

    if [ -n "$JSON_FILE" ]; then
      bash "$NOTIFY_SCRIPT" "$JSON_FILE" "fail"
    else
      bash "$NOTIFY_SCRIPT" "" "fail"
    fi
  fi

  # 임시 디렉토리 정리
  rm -rf "$RESULT_DIR"

  echo ""
  echo -e "${GREEN}👀 계속 감시 중... (파일 변경 대기)${NC}"
}

# 파일 변경 감시 루프
# .tsx, .ts, .css 파일 변경 시 트리거
# node_modules, .next, e2e 디렉토리 제외
while true; do
  inotifywait -r -q \
    --exclude '(node_modules|\.next|\.git|e2e|__tests__)' \
    -e modify,create,delete \
    --include '\.(tsx?|css)$' \
    "$CONSUMER_DIR/src/" 2>/dev/null || true

  run_crawl_test
done
