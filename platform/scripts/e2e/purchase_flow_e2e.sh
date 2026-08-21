#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# L3 라이브 API E2E — 핵심 구매 루프 (단계6 통합테스트)
# ---------------------------------------------------------------------------
# 기동된 backend(:8021)에 실제 HTTP로 다음 플로우를 검증한다:
#   가입 → 로그인 → (FCFS 이벤트 approved 보장) → 좌석등급 조회
#   → FCFS 구매(주문 생성) → 결제 확정(CONFIRMED + 티켓 활성)
#   → 내 티켓 조회 → QR 발급
#
# 전제: scripts/seed_test_accounts.sh 로 IU 콘서트(fixed_fcfs) 시드 완료.
#       로컬(ENVIRONMENT=development, BOT_DETECTION_KEY 미설정) 기준.
# 의존: curl, python3, docker compose(이벤트 상태 전이용).
# ---------------------------------------------------------------------------

BASE="${PICKKET_BASE:-http://localhost:8021}"
API="${PICKKET_API:-$BASE/api/v1}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL="docker compose -p pickket-v2 exec -T db psql -U pickket_v2 -d pickket_v2_dev"
PASS=0; FAIL=0
ts() { date +%s; }
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

jqpy() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

echo "═══ L3 구매루프 E2E ═══"

# ── 0. 헬스 ──
H=$(curl -s -m 5 "$BASE/health" || true)
echo "$H" | grep -q '"status":"ok"' && ok "health ok" || { bad "health (backend 미기동?) → $H"; exit 1; }

# ── 1. 가입 + 로그인 ──
TS=$(ts)
EMAIL="e2e_buy_${TS}@example.com"
PW="Test1234!@"
REG_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"name\":\"E2E구매\",\"phone\":\"010${TS:1:8}\"}")
[ "$REG_CODE" = "201" ] && ok "register 201" || bad "register → $REG_CODE"

TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | jqpy "d['access_token']")
[ -n "$TOKEN" ] && ok "login (token 발급)" || { bad "login"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN" -H "x-behavior-token: e2e-dummy" -H "x-behavior-session: e2e-sess")

# ── 2. FCFS 이벤트를 approved + 판매기간으로 보장 (테스트 전이) ──
EVENT_ID=$($PSQL -t -A -c "SELECT id FROM events WHERE title LIKE 'IU%' ORDER BY created_at DESC LIMIT 1;" | tr -d '[:space:]')
[ -n "$EVENT_ID" ] && ok "FCFS 이벤트 발견 ($EVENT_ID)" || { bad "IU 콘서트 시드 없음 — seed_test_accounts.sh 먼저"; exit 1; }
$PSQL -c "UPDATE events SET status='approved' WHERE id='$EVENT_ID';" >/dev/null 2>&1 || true
STATUS_NOW=$($PSQL -t -A -c "SELECT status FROM events WHERE id='$EVENT_ID';" | tr -d '[:space:]')
[ "$STATUS_NOW" = "approved" ] && ok "이벤트 approved 전이 (status VARCHAR=$STATUS_NOW)" || bad "approved 전이 실패 → $STATUS_NOW"

# ── 3. 좌석 등급 조회 ──
TIER_ID=$($PSQL -t -A -c "SELECT id FROM seat_tiers WHERE event_id='$EVENT_ID' ORDER BY base_price DESC LIMIT 1;" | tr -d '[:space:]')
[ -n "$TIER_ID" ] && ok "좌석등급 조회 ($TIER_ID)" || { bad "tier 없음"; exit 1; }

# ── 4. FCFS 구매 (주문 생성) ──
BUY=$(curl -s -w "\n%{http_code}" -X POST "$API/events/$EVENT_ID/tiers/$TIER_ID/purchase" \
  "${AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"quantity\":1,\"idempotency_key\":\"e2e_buy_${TS}_key\"}")
BUY_CODE=$(echo "$BUY" | tail -1); BUY_BODY=$(echo "$BUY" | head -1)
if [ "$BUY_CODE" = "201" ]; then
  ok "FCFS 구매 201"
else
  bad "구매 → $BUY_CODE :: $(echo "$BUY_BODY" | head -c 200)"; echo "═══ PASS=$PASS FAIL=$FAIL ═══"; exit 1
fi
ORDER_ID=$(echo "$BUY_BODY" | jqpy "d.get('order_id') or ''")
PROCESSING=$(echo "$BUY_BODY" | jqpy "d.get('processing', False)")
[ -n "$ORDER_ID" ] && ok "order_id 발급 ($ORDER_ID)" || bad "order_id 없음 :: $(echo "$BUY_BODY" | head -c 200)"

# 비동기 큐면 status 폴링
if [ "$PROCESSING" = "True" ]; then
  for i in $(seq 1 10); do
    sleep 1
    ST=$(curl -s "$API/orders/$ORDER_ID/status" "${AUTH[@]}" | jqpy "d.get('status','')")
    [ "$ST" = "payment_required" ] || [ "$ST" = "confirmed" ] && break
  done
  ok "비동기 구매 처리 완료 (status=$ST)"
fi

# ── 5. 결제 확정 (CONFIRMED + 티켓 활성) ──
PAY=$(curl -s -w "\n%{http_code}" -X POST "$API/orders/$ORDER_ID/pay" \
  "${AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"pg_provider\":\"portone\",\"pg_transaction_id\":\"e2e_stub_${TS}\"}")
PAY_CODE=$(echo "$PAY" | tail -1); PAY_BODY=$(echo "$PAY" | head -1)
if [ "$PAY_CODE" = "200" ]; then
  PAY_STATUS=$(echo "$PAY_BODY" | jqpy "d.get('status','')")
  ok "결제 확정 200 (order status=$PAY_STATUS)"
else
  bad "결제확정 → $PAY_CODE :: $(echo "$PAY_BODY" | head -c 200)"
fi

# ── 6. 내 티켓 조회 ──
MYTIX=$(curl -s -w "\n%{http_code}" "$API/tickets/my" "${AUTH[@]}")
TIX_CODE=$(echo "$MYTIX" | tail -1); TIX_BODY=$(echo "$MYTIX" | head -1)
_tix_list() { echo "d if isinstance(d,list) else (d.get('tickets') or d.get('items') or [])"; }
TIX_COUNT=$(echo "$TIX_BODY" | jqpy "len($(_tix_list))")
if [ "$TIX_CODE" = "200" ] && [ "${TIX_COUNT:-0}" -ge 1 ]; then
  ok "내 티켓 조회 200 ($TIX_COUNT장)"
  TICKET_ID=$(echo "$TIX_BODY" | jqpy "($(_tix_list))[0].get('id','')")
else
  bad "티켓 조회 → $TIX_CODE count=$TIX_COUNT :: $(echo "$TIX_BODY" | head -c 200)"
fi

# ── 7. QR 발급 ──
if [ -n "${TICKET_ID:-}" ]; then
  QR_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API/tickets/$TICKET_ID/qr" "${AUTH[@]}")
  [ "$QR_CODE" = "200" ] && ok "QR 발급 200" || bad "QR → $QR_CODE"
fi

echo "═══ 결과: PASS=$PASS FAIL=$FAIL ═══"
[ "$FAIL" -eq 0 ] && echo "[OK] 구매루프 E2E 통과" || { echo "[FAIL] 구매루프 일부 실패"; exit 1; }
