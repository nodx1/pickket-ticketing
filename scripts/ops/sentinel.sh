#!/usr/bin/env bash
# PICKKET 머신층 감시 — OS crontab 이 5분마다 실행. Claude 세션과 무관하게 동작.
# 원칙: 정상이면 아무것도 안 함(AI 비용 0). 이상 시에만 기록·알림·(옵션)AI 진단.
# 설계 근거: docs/OPS_ORCHESTRATION_PLAN.md §2.2
set -u

REPO="/home/oem/Development/active/pickket-v3"
OPS_ENV="$REPO/scripts/ops/ops.env"
STATE_DIR="$HOME/.local/state/pickket-ops"
ALERTS_LOG="$REPO/docs/ops/ALERTS.log"
PENDING="$REPO/docs/ops/PENDING_ALERTS.md"
COOLDOWN_SEC=1800   # 같은 대상 재알림 최소 간격(30분)
UA="Mozilla/5.0 (X11; Linux x86_64) pickket-sentinel"

mkdir -p "$STATE_DIR"
[ -f "$OPS_ENV" ] && . "$OPS_ENV"
NTFY_TOPIC="${NTFY_TOPIC:-}"
SENTINEL_AI_DIAGNOSIS="${SENTINEL_AI_DIAGNOSIS:-0}"

now_kst() { TZ=Asia/Seoul date '+%Y-%m-%d %H:%M'; }

notify() { # $1 제목 $2 본문(상세는 로그에만 — ntfy 본문 최소화)
  command -v notify-send >/dev/null && notify-send -u critical "PICKKET $1" "$2" 2>/dev/null
  if [ -n "$NTFY_TOPIC" ]; then
    curl -fsS -m 10 -H "Title: PICKKET $1" -H "Priority: high" \
      -d "$2" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
  fi
}

alert() { # $1 대상키 $2 제목 $3 상세
  local key="$1" title="$2" detail="$3"
  local stamp_file="$STATE_DIR/alert-$key"
  local now epoch_last
  now=$(date +%s)
  epoch_last=$(cat "$stamp_file" 2>/dev/null || echo 0)
  echo "[$(now_kst)] ALERT $key: $title — $detail" >> "$ALERTS_LOG"
  # 쿨다운: 30분 내 같은 대상 재알림 억제(로그는 항상 남김)
  if [ $((now - epoch_last)) -lt $COOLDOWN_SEC ]; then return; fi
  echo "$now" > "$stamp_file"

  { echo ""
    echo "## [High] $(now_kst) $title"
    echo "- 감지: sentinel.sh ($key)"
    echo "- 상태: 미조치 — $detail"
    echo "- 다음: 해당 런북 확인 (docs/ops/runbooks/)"
  } >> "$PENDING"

  notify "$title" "$detail"

  if [ "$SENTINEL_AI_DIAGNOSIS" = "1" ] && command -v claude >/dev/null; then
    # 헤드리스 진단 — MCP 비의존 도구만 쓰도록 지시. 결과는 로그로.
    ( cd "$REPO" && timeout 600 claude -p \
      "sentinel 이 '$title' ($detail) 을 감지했다. docs/ops/runbooks/ 의 해당 런북을 따라 bash/curl 로만 진단하고(수정 금지), 원인 추정과 조치안을 docs/ops/PENDING_ALERTS.md 의 해당 항목 아래에 append 하라." \
      >> "$STATE_DIR/diagnosis-$key.log" 2>&1 & )
  fi
}

recover() { # $1 대상키 $2 제목 — 장애→복구 전환 시 1회 알림
  local key="$1" stamp_file="$STATE_DIR/alert-$key"
  if [ -f "$stamp_file" ]; then
    rm -f "$stamp_file"
    echo "[$(now_kst)] RECOVER $key" >> "$ALERTS_LOG"
    notify "복구" "$2 정상화 확인"
  fi
}

check_http() { # $1 키 $2 이름 $3 URL $4 기대문자열(빈값=상태코드만)
  # -L: admin 등은 / → /auth 307 리다이렉트가 정상이라 최종 응답 기준으로 판정.
  local key="$1" name="$2" url="$3" expect="$4" body code
  body=$(curl -fsSL --max-redirs 3 -m 15 -A "$UA" -w '\n%{http_code}' "$url" 2>/dev/null)
  code=$(echo "$body" | tail -1)
  if [ "$code" != "200" ]; then
    alert "$key" "$name 응답 이상" "HTTP ${code:-timeout} — $url"
    return
  fi
  if [ -n "$expect" ] && ! echo "$body" | grep -q "$expect"; then
    alert "$key" "$name 헬스 비정상" "200 이지만 기대값('$expect') 부재 — $url"
    return
  fi
  recover "$key" "$name"
}

# ── 대상 (전부 공개 URL — 내부 지표는 W2 에서 readonly DB/ops-metrics 로 확장) ──
check_http "go-ready"  "organizer(go)" "https://go.pickket.kr/api/health/ready" '"ok":true'
check_http "backend"   "backend(api)"  "https://api.pickket.kr/health/live" ""
check_http "consumer"  "consumer(www)" "https://www.pickket.kr/" ""
check_http "admin"     "admin"         "https://admin.pickket.kr/" ""

# ── 발송큐 적체 (W2: readonly psql 또는 ops-metrics 후 활성화) ──
# queued=$(psql "$GO_DB_RO_URL" -Atc "SELECT COUNT(*) FROM event_messages WHERE status IN ('queued','sending') AND updated_at < NOW() - INTERVAL '10 minutes'")
# [ "${queued:-0}" -gt 0 ] && alert "send-queue" "발송큐 적체" "${queued}건 10분+ 정체 — runbooks/incident-발송장애.md"

exit 0
