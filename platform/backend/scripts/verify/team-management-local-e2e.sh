#!/usr/bin/env bash
# 팀원 관리 전 구간 — 실 PostgreSQL. 목록·해제·역할변경 신규 엔드포인트 포함.
set -uo pipefail
API=http://127.0.0.1:8029
PSQL="docker exec pickket-v2-db psql -U pickket_v2 -d pickket_v2_dev -tAc"
T="$1"
ok=0; bad=0
chk(){ if [ "$2" = "$3" ]; then echo "  ✅ $1"; ok=$((ok+1)); else echo "  🔴 $1 — 기대 [$3] 실제 [$2]"; bad=$((bad+1)); fi; }
jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);v=d$1;print('null' if v is None else v)" 2>/dev/null; }
svc(){ curl -s --max-time 20 -H "X-Pickket-Service-Token: $T" "$@"; }
reg(){ curl -s --max-time 20 -X POST "$API/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"Passw0rd!23\",\"name\":\"$2\",\"phone\":\"01012345678\",\"is_organizer\":$3}"; }
verify(){ curl -s --max-time 20 -X POST "$API/api/v1/auth/verify-token" -H 'Content-Type: application/json' \
  -H "X-Pickket-Service-Token: $T" -d "{\"token\":\"$1\"}"; }

ST=$(date +%s)
O=$(reg "g_o_$ST@example.com" "소유자" true); M=$(reg "g_m_$ST@example.com" "팀원" false)
OID=$(printf '%s' "$O" | jget "['user']['id']"); MID=$(printf '%s' "$M" | jget "['user']['id']")
MTOK=$(printf '%s' "$M" | jget "['access_token']")
echo "  owner=$OID member=$MID"

echo "── G. 멤버십 등록 (실 HMAC)"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BODY="{\"go_event_organizer_id\":\"inv2-$ST\",\"v2_event_id\":null,\"v2_organizer_ref\":\"$OID\",\"v2_user_id\":\"$MID\",\"role\":\"manager\",\"display_order\":0}"
SIG=$(python3 -c "import hmac,hashlib,sys;print(hmac.new(sys.argv[1].encode(), f'{sys.argv[2]}.{sys.argv[3]}'.encode(), hashlib.sha256).hexdigest())" "$T" "$TS" "$BODY")
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/internal/organizer/teams/import" \
  -H 'Content-Type: application/json' -H "X-Pickket-Signature: $SIG" -H "X-Pickket-Timestamp: $TS" \
  -H "X-Pickket-Event: organizer.team.import" -H "X-Pickket-Delivery-Id: $(cat /proc/sys/kernel/random/uuid)" -d "$BODY")
chk "import 200" "$C" "200"

echo "── H. 🔴 신규: 팀 목록 조회"
L=$(svc "$API/api/v1/internal/organizers/$OID/team")
chk "멤버 1명"      "$(printf '%s' "$L" | jget "['data']['members'][0]['userId']")" "$MID"
chk "역할 organizer" "$(printf '%s' "$L" | jget "['data']['members'][0]['role']")"   "organizer"
chk "활성 표시"      "$(printf '%s' "$L" | jget "['data']['members'][0]['isActive']")" "True"

echo "── I. 🔴 신규: 역할 변경 (in-place)"
P=$(svc -X PATCH "$API/api/v1/internal/organizers/$OID/team/$MID" -H 'Content-Type: application/json' \
  -d "{\"organizer_ref\":\"$OID\",\"role\":\"staff\"}")
chk "변경됨" "$(printf '%s' "$P" | jget "['data']['role']")" "staff"
chk "세션에 반영" "$(verify "$MTOK" | jget "['organizer_role']")" "staff"
chk "행이 늘지 않음" "$($PSQL "select count(*) from organizer_team_members where user_id='$MID'")" "1"

echo "── J. 🔴 소유자 보호"
DO=$(svc -o /dev/null -w '%{http_code}' -X DELETE "$API/api/v1/internal/organizers/$OID/team/$OID")
chk "소유자 해제 차단" "$DO" "200"
chk "소유자 멤버십 없음(애초에)" "$($PSQL "select count(*) from organizer_team_members where user_id='$OID'")" "0"

echo "── K. 🔴 신규: 해제 → 즉시 조직 안 보임"
D=$(svc -X DELETE "$API/api/v1/internal/organizers/$OID/team/$MID")
chk "removed=true" "$(printf '%s' "$D" | jget "['data']['removed']")" "True"
chk "세션에서 조직 사라짐" "$(verify "$MTOK" | jget "['organizer_ref']")" "null"
chk "원장 0행" "$($PSQL "select count(*) from organizer_team_members where user_id='$MID'")" "0"

echo
echo "  ⟹ $ok 통과 · $bad 실패"
$PSQL "update users set is_active=false where email like 'g_o_%@example.com' or email like 'g_m_%@example.com'" >/dev/null
[ "$bad" -eq 0 ]
