#!/usr/bin/env bash
# 팀원 복구 로컬 실검증 — 실 PostgreSQL + 실 HMAC.
# 🔴 go 의 수락 라우트가 쓰는 것과 **같은 시크릿 해석**(GO_WEBHOOK_SECRET 우선)으로 서명한다.
set -uo pipefail
API=http://127.0.0.1:8029
PSQL="docker exec pickket-v2-db psql -U pickket_v2 -d pickket_v2_dev -tAc"
SVC="$1"; SEC="$1"
ok=0; bad=0
chk(){ if [ "$2" = "$3" ]; then echo "  ✅ $1"; ok=$((ok+1)); else echo "  🔴 $1 — 기대 [$3] 실제 [$2]"; bad=$((bad+1)); fi; }
jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);v=d$1;print('null' if v is None else v)" 2>/dev/null; }
reg(){ curl -s --max-time 20 -X POST "$API/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"Passw0rd!23\",\"name\":\"$2\",\"phone\":\"01012345678\",\"is_organizer\":$3}"; }
verify(){ curl -s --max-time 20 -X POST "$API/api/v1/auth/verify-token" -H 'Content-Type: application/json' \
  -H "X-Pickket-Service-Token: $SVC" -d "{\"token\":\"$1\"}"; }

ST=$(date +%s)
O=$(reg "f_o_$ST@example.com" "소유자" true)
M=$(reg "f_m_$ST@example.com" "팀원" false)     # ← 수락 라우트가 이제 보내는 값
OID=$(printf '%s' "$O" | jget "['user']['id']"); OTOK=$(printf '%s' "$O" | jget "['access_token']")
MID=$(printf '%s' "$M" | jget "['user']['id']"); MTOK=$(printf '%s' "$M" | jget "['access_token']")
echo "  owner=$OID  member=$MID"

echo "── A. 멤버십 전 — 팀원은 조직이 없다"
chk "organizer_ref 없음" "$(verify "$MTOK" | jget "['organizer_ref']")" "null"

echo "── B. 🔴 실 HMAC 으로 teams/import (수락 라우트와 동일 페이로드)"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BODY="{\"go_event_organizer_id\":\"invited-$ST\",\"v2_event_id\":null,\"v2_organizer_ref\":\"$OID\",\"v2_user_id\":\"$MID\",\"role\":\"manager\",\"display_order\":0}"
SIG=$(python3 -c "import hmac,hashlib,sys;print(hmac.new(sys.argv[1].encode(), f'{sys.argv[2]}.{sys.argv[3]}'.encode(), hashlib.sha256).hexdigest())" "$SEC" "$TS" "$BODY")
RES=$(curl -s -w '\n%{http_code}' --max-time 20 -X POST "$API/api/v1/internal/organizer/teams/import" \
  -H 'Content-Type: application/json' -H "X-Pickket-Signature: $SIG" -H "X-Pickket-Timestamp: $TS" \
  -H "X-Pickket-Event: organizer.team.import" -H "X-Pickket-Delivery-Id: $(cat /proc/sys/kernel/random/uuid)" -d "$BODY")
chk "import HTTP 200" "$(printf '%s' "$RES" | tail -1)" "200"
chk "created=true" "$(printf '%s' "$RES" | head -1 | jget "['created']")" "True"

echo "── C. 🔴 팀원 로그인이 조직을 본다"
R=$(verify "$MTOK")
chk "organizer_ref = 소유자" "$(printf '%s' "$R" | jget "['organizer_ref']")" "$OID"
chk "go_account_id = 소유자앵커" "$(printf '%s' "$R" | jget "['go_account_id']")" "$OID"
chk "membership_of 표시" "$(printf '%s' "$R" | jget "['membership_of']")" "$OID"
chk "role = organizer" "$(printf '%s' "$R" | jget "['organizer_role']")" "organizer"

echo "── D. 소유자 무회귀"
R2=$(verify "$OTOK")
chk "owner ref 그대로" "$(printf '%s' "$R2" | jget "['organizer_ref']")" "$OID"
chk "owner 위임표시 없음" "$(printf '%s' "$R2" | jget "['membership_of']")" "null"
chk "owner role" "$(printf '%s' "$R2" | jget "['organizer_role']")" "owner"

echo "── E. 🔴 멤버십 해제 → 즉시 자기 테넌트로"
$PSQL "delete from organizer_team_members where user_id='$MID'" >/dev/null
chk "해제 후 조직 없음" "$(verify "$MTOK" | jget "['organizer_ref']")" "null"

echo "── F. 🔴 계정 정지 → 즉시 차단"
$PSQL "update users set is_active=false where id='$MID'" >/dev/null
R3=$(verify "$MTOK")
chk "valid=false" "$(printf '%s' "$R3" | jget "['valid']")" "False"
chk "reason" "$(printf '%s' "$R3" | jget "['reason']")" "user_inactive"

echo
echo "  ⟹ $ok 통과 · $bad 실패"
$PSQL "update users set is_active=false where email like 'f_o_%@example.com' or email like 'f_m_%@example.com'" >/dev/null
[ "$bad" -eq 0 ]
