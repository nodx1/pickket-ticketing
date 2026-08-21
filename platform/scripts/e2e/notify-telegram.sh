#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────
# Pickket 크롤링 결과 → 텔레그램 보고 v2
#
# 사용법:
#   ./scripts/e2e/notify-telegram.sh <결과JSON파일> [pass|fail]
#
# 환경변수:
#   TELEGRAM_BOT_TOKEN  — BotFather에서 받은 토큰
#   TELEGRAM_CHAT_ID    — 보고할 채팅/그룹 ID
#   GITHUB_RUN_URL      — (선택) GitHub Actions 실행 URL
# ────────────────────────────────────────────────────────────────
set -euo pipefail

REPORT_FILE="${1:-}"
STATUS="${2:-unknown}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
RUN_URL="${GITHUB_RUN_URL:-}"

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "⚠️  TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 설정되지 않음 — 알림 건너뜀"
  exit 0
fi

# ── 메시지 생성 ──
TIMESTAMP=$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M KST')

if [ "$STATUS" = "pass" ]; then
  ICON="✅"
  TITLE="크롤링 통과"
elif [ "$STATUS" = "fail" ]; then
  ICON="🚨"
  TITLE="크롤링 실패"
else
  ICON="📋"
  TITLE="크롤링 결과"
fi

# JSON 리포트 파싱
DETAIL=""
if [ -n "$REPORT_FILE" ] && [ -f "$REPORT_FILE" ]; then
  TOTAL_PAGES=$(jq -r '.totalPages // 0' "$REPORT_FILE" 2>/dev/null || echo "0")
  TARGET=$(jq -r '.target // "unknown"' "$REPORT_FILE" 2>/dev/null || echo "unknown")

  # 심각도별
  CRITICAL=$(jq -r '.bySeverity.critical // 0' "$REPORT_FILE" 2>/dev/null || echo "0")
  WARNING=$(jq -r '.bySeverity.warning // 0' "$REPORT_FILE" 2>/dev/null || echo "0")
  INFO=$(jq -r '.bySeverity.info // 0' "$REPORT_FILE" 2>/dev/null || echo "0")

  # 유형별
  SSR=$(jq -r '.byType.ssr // 0' "$REPORT_FILE" 2>/dev/null || echo "0")
  PAGEERROR=$(jq -r '.byType.pageerror // 0' "$REPORT_FILE" 2>/dev/null || echo "0")
  LOAD=$(jq -r '.byType.load // 0' "$REPORT_FILE" 2>/dev/null || echo "0")
  NETWORK=$(jq -r '.byType.network // 0' "$REPORT_FILE" 2>/dev/null || echo "0")
  BROKEN=$(jq -r '.byType.brokenLinks // 0' "$REPORT_FILE" 2>/dev/null || echo "0")
  CONSOLE=$(jq -r '.byType.console // 0' "$REPORT_FILE" 2>/dev/null || echo "0")

  DETAIL="
🎯 <b>대상:</b> ${TARGET}
📄 <b>방문:</b> ${TOTAL_PAGES}개 페이지

🔴 CRITICAL: ${CRITICAL}건"

  # 유형 상세 (0이 아닌 것만)
  TYPE_DETAIL=""
  [ "$SSR" -gt 0 ] 2>/dev/null && TYPE_DETAIL="${TYPE_DETAIL}  SSR에러 ${SSR}"
  [ "$PAGEERROR" -gt 0 ] 2>/dev/null && TYPE_DETAIL="${TYPE_DETAIL}  예외 ${PAGEERROR}"
  [ "$LOAD" -gt 0 ] 2>/dev/null && TYPE_DETAIL="${TYPE_DETAIL}  로드실패 ${LOAD}"
  [ -n "$TYPE_DETAIL" ] && DETAIL="${DETAIL} (${TYPE_DETAIL})"

  DETAIL="${DETAIL}
🟡 WARNING: ${WARNING}건"
  TYPE_DETAIL=""
  [ "$NETWORK" -gt 0 ] 2>/dev/null && TYPE_DETAIL="${TYPE_DETAIL}  네트워크 ${NETWORK}"
  [ "$BROKEN" -gt 0 ] 2>/dev/null && TYPE_DETAIL="${TYPE_DETAIL}  깨진링크 ${BROKEN}"
  [ -n "$TYPE_DETAIL" ] && DETAIL="${DETAIL} (${TYPE_DETAIL})"

  DETAIL="${DETAIL}
🔵 INFO: ${INFO}건"

  # CRITICAL이면 STATUS 오버라이드
  if [ "$CRITICAL" -gt 0 ] 2>/dev/null && [ "$STATUS" = "pass" ]; then
    STATUS="fail"
    ICON="🚨"
    TITLE="크롤링 실패"
  fi

  # 주요 이슈 (critical + warning만, 최대 5건)
  ERROR_DETAIL=$(jq -r '
    [.uniqueErrors[] | select(.severity == "critical" or .severity == "warning")] |
    .[0:5] | to_entries[] |
    "  \(if .value.severity == "critical" then "🔴" else "🟡" end) \(.value.message | .[0:80])\(if .value.count > 1 then " (×\(.value.count))" else "" end)"
  ' "$REPORT_FILE" 2>/dev/null || echo "")

  if [ -n "$ERROR_DETAIL" ]; then
    DETAIL="${DETAIL}

<b>주요 이슈:</b>
${ERROR_DETAIL}"
  fi

  # 느린 페이지 (최대 3건)
  SLOW=$(jq -r '
    .slowPages[:3] | to_entries[] |
    "  🐢 \(.value.url) — \(.value.loadTimeMs)ms"
  ' "$REPORT_FILE" 2>/dev/null || echo "")

  if [ -n "$SLOW" ]; then
    DETAIL="${DETAIL}

<b>느린 페이지:</b>
${SLOW}"
  fi
else
  DETAIL=""
fi

# GitHub 링크
LINK_TEXT=""
if [ -n "$RUN_URL" ]; then
  LINK_TEXT="
🔗 <a href=\"${RUN_URL}\">상세 로그</a>"
fi

# ── 메시지 전송 ──
MESSAGE="${ICON} <b>Pickket ${TITLE}</b>
📅 ${TIMESTAMP}
${DETAIL}${LINK_TEXT}"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg chat_id "$CHAT_ID" \
    --arg text "$MESSAGE" \
    '{
      chat_id: $chat_id,
      text: $text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }'
  )" > /dev/null

echo "✅ 텔레그램 알림 전송 완료"
