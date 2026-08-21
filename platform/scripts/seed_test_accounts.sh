#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# 실증 테스트용 시드 데이터 생성
# - 관리자 / 주최자 / 일반 사용자 계정 3개
# - 판매모드별 행사 2개 (fixed_fcfs, point_lottery)
# - 각 행사에 좌석 등급 2개씩
# ---------------------------------------------------------------------------

API="http://localhost:8021/api/v1"
DB_CMD="docker compose -p pickket-v2 exec -T db psql -U pickket_v2 -d pickket_v2_dev"
DOCKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker"

echo "═══════════════════════════════════════════════"
echo " Pickket v2 — 실증 테스트 시드 데이터 생성"
echo "═══════════════════════════════════════════════"

# ── 1. 계정 생성 ──────────────────────────────────

echo ""
echo "[1/4] 테스트 계정 생성..."

# 관리자
ADMIN_RES=$(curl -s -w "\n%{http_code}" -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@pickket.kr",
    "password": "Admin1234!",
    "name": "관리자",
    "phone": "01000000001",
    "is_organizer": false
  }')
ADMIN_HTTP=$(echo "$ADMIN_RES" | tail -1)
ADMIN_BODY=$(echo "$ADMIN_RES" | sed '$d')
if [ "$ADMIN_HTTP" = "201" ]; then
  echo "  ✓ admin@pickket.kr 생성"
elif [ "$ADMIN_HTTP" = "409" ]; then
  echo "  · admin@pickket.kr 이미 존재"
else
  echo "  ✗ admin 생성 실패 ($ADMIN_HTTP): $ADMIN_BODY"
fi

# 주최자
ORG_RES=$(curl -s -w "\n%{http_code}" -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "organizer@pickket.kr",
    "password": "Organizer1234!",
    "name": "픽켓 이벤트",
    "phone": "01000000002",
    "is_organizer": true
  }')
ORG_HTTP=$(echo "$ORG_RES" | tail -1)
ORG_BODY=$(echo "$ORG_RES" | sed '$d')
if [ "$ORG_HTTP" = "201" ]; then
  echo "  ✓ organizer@pickket.kr 생성"
elif [ "$ORG_HTTP" = "409" ]; then
  echo "  · organizer@pickket.kr 이미 존재"
else
  echo "  ✗ organizer 생성 실패 ($ORG_HTTP): $ORG_BODY"
fi

# 일반 사용자
USER_RES=$(curl -s -w "\n%{http_code}" -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@pickket.kr",
    "password": "User1234!",
    "name": "김민수",
    "phone": "01000000003",
    "is_organizer": false
  }')
USER_HTTP=$(echo "$USER_RES" | tail -1)
USER_BODY=$(echo "$USER_RES" | sed '$d')
if [ "$USER_HTTP" = "201" ]; then
  echo "  ✓ user@pickket.kr 생성"
elif [ "$USER_HTTP" = "409" ]; then
  echo "  · user@pickket.kr 이미 존재"
else
  echo "  ✗ user 생성 실패 ($USER_HTTP): $USER_BODY"
fi

# ── 2. 역할 부여 (DB 직접) ──────────────────────────

echo ""
echo "[2/4] 역할 부여..."

cd "$DOCKER_DIR"

$DB_CMD -c "UPDATE users SET is_admin = true, is_verified = true WHERE email = 'admin@pickket.kr';" 2>/dev/null
echo "  ✓ admin@pickket.kr → is_admin=true, is_verified=true"

$DB_CMD -c "UPDATE users SET is_organizer = true, is_verified = true WHERE email = 'organizer@pickket.kr';" 2>/dev/null
echo "  ✓ organizer@pickket.kr → is_organizer=true, is_verified=true"

$DB_CMD -c "UPDATE users SET is_verified = true WHERE email = 'user@pickket.kr';" 2>/dev/null
echo "  ✓ user@pickket.kr → is_verified=true"

# ── 3. 주최자 로그인 & 행사 생성 ──────────────────────

echo ""
echo "[3/4] 주최자 로그인 후 행사 생성..."

LOGIN_RES=$(curl -s -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "organizer@pickket.kr", "password": "Organizer1234!"}')
TOKEN=$(echo "$LOGIN_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
  echo "  ✗ 주최자 로그인 실패"
  echo "  응답: $LOGIN_RES"
  exit 1
fi
echo "  ✓ 주최자 로그인 성공"

AUTH="Authorization: Bearer $TOKEN"

# ── 행사 1: 정가 선착순 (CONCERT) ──

echo ""
echo "  [행사 1] IU 2026 콘서트 — 정가 선착순 (fixed_fcfs)"
EVENT1_RES=$(curl -s -w "\n%{http_code}" -X POST "$API/events/" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{
    "title": "IU 2026 HEREH 앙코르 콘서트",
    "description": "아이유의 2026년 전국투어 서울 앙코르 공연. 팬들의 뜨거운 성원에 힘입어 올림픽공원 체조경기장에서 특별한 밤을 준비했습니다. 새 앨범 수록곡 최초 공개와 함께하는 감동의 라이브!",
    "venue": "올림픽공원 KSPO DOME",
    "event_date": "2026-06-15T19:00:00+09:00",
    "bidding_opens_at": "2026-04-01T10:00:00+09:00",
    "bidding_closes_at": "2026-06-14T23:59:00+09:00",
    "total_seats": 15000,
    "min_price": 99000,
    "max_price": 176000,
    "category": "CONCERT",
    "sub_category": "K-POP",
    "location_city": "서울",
    "artist_name": "IU (아이유)",
    "age_restriction": "전체 관람가",
    "tags": "아이유,IU,HEREH,앙코르,콘서트,KPOP",
    "duration_minutes": 150,
    "image_url": "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=1200&q=80",
    "thumbnail_url": "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=480&q=80",
    "notice": "※ 1인 2매 제한\\n※ 본인 확인 필수 (신분증 지참)\\n※ 공연 시작 30분 전 입장 마감\\n※ 음식물 반입 불가",
    "delivery_method": "mobile",
    "seat_type": "assigned",
    "require_checkin": true,
    "cancellation_fee_tiers": [
      {"days_before": 30, "fee_pct": 0},
      {"days_before": 7, "fee_pct": 10},
      {"days_before": 3, "fee_pct": 30},
      {"days_before": 0, "fee_pct": 50}
    ]
  }')
EVENT1_HTTP=$(echo "$EVENT1_RES" | tail -1)
EVENT1_BODY=$(echo "$EVENT1_RES" | sed '$d')
EVENT1_ID=$(echo "$EVENT1_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

if [ -n "$EVENT1_ID" ]; then
  echo "    ✓ 생성 완료 (ID: $EVENT1_ID)"

  # 좌석 등급: VIP, R석
  curl -s -X POST "$API/events/$EVENT1_ID/tiers" \
    -H "Content-Type: application/json" -H "$AUTH" \
    -d '{
      "name": "VIP",
      "capacity": 3000,
      "base_price": 176000,
      "sale_mode": "fixed_fcfs",
      "face_price": 176000,
      "view_description": "무대 최근접 프리미엄 좌석. 아티스트와 가장 가까운 거리에서 공연을 즐기세요.",
      "distance_from_stage": 15,
      "view_rating": 5,
      "position_label": "1층 VIP 블록 A-F",
      "max_group_size": 2
    }' > /dev/null
  echo "    ✓ VIP 등급 (3,000석 / ₩176,000)"

  curl -s -X POST "$API/events/$EVENT1_ID/tiers" \
    -H "Content-Type: application/json" -H "$AUTH" \
    -d '{
      "name": "R석",
      "capacity": 12000,
      "base_price": 99000,
      "sale_mode": "fixed_fcfs",
      "face_price": 99000,
      "view_description": "1~2층 지정좌석. 넓은 시야에서 무대 전체를 감상할 수 있습니다.",
      "distance_from_stage": 50,
      "view_rating": 4,
      "position_label": "1-2층 R블록",
      "max_group_size": 4
    }' > /dev/null
  echo "    ✓ R석 등급 (12,000석 / ₩99,000)"
else
  echo "    ✗ 행사 1 생성 실패 ($EVENT1_HTTP): $EVENT1_BODY"
fi

# ── 행사 2: 포인트 추첨 (SPORTS) ──

echo ""
echo "  [행사 2] 2026 프로야구 올스타전 — 포인트 추첨 (point_lottery)"
EVENT2_RES=$(curl -s -w "\n%{http_code}" -X POST "$API/events/" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{
    "title": "2026 신한 SOL 뱅크 KBO 올스타전",
    "description": "2026 KBO 리그 올스타전! 최고의 선수들이 한자리에 모이는 야구 팬들의 축제. 홈런 더비, 올스타 본경기, 그리고 특별 팬 이벤트까지. 고척스카이돔에서 펼쳐지는 별들의 향연을 놓치지 마세요.",
    "venue": "고척스카이돔",
    "event_date": "2026-07-19T17:00:00+09:00",
    "bidding_opens_at": "2026-05-01T10:00:00+09:00",
    "bidding_closes_at": "2026-07-10T23:59:00+09:00",
    "total_seats": 20000,
    "min_price": 30000,
    "max_price": 150000,
    "category": "SPORTS",
    "sub_category": "야구",
    "location_city": "서울",
    "artist_name": "KBO 올스타",
    "age_restriction": "전체 관람가",
    "tags": "KBO,올스타전,프로야구,고척돔,홈런더비",
    "duration_minutes": 240,
    "image_url": "https://images.unsplash.com/photo-1566577739112-5180d4bf9390?w=1200&q=80",
    "thumbnail_url": "https://images.unsplash.com/photo-1566577739112-5180d4bf9390?w=480&q=80",
    "home_team": "KBO 올스타 나눔팀",
    "away_team": "KBO 올스타 드림팀",
    "parking_info": "고척스카이돔 주차장 이용 가능 (선착순 2,000대)\\n대중교통 이용 권장 (지하철 7호선 신풍역 1번 출구)",
    "notice": "※ 포인트 추첨 방식 — 마일리지 투자로 당첨 확률 상승\\n※ 추첨 결과: 7/12(일) 18:00 발표\\n※ 미당첨 시 포인트 100% 환급\\n※ 우천 시 돔구장이므로 정상 진행",
    "delivery_method": "mobile",
    "seat_type": "assigned",
    "require_checkin": true,
    "cancellation_fee_tiers": [
      {"days_before": 14, "fee_pct": 0},
      {"days_before": 7, "fee_pct": 10},
      {"days_before": 0, "fee_pct": 30}
    ]
  }')
EVENT2_HTTP=$(echo "$EVENT2_RES" | tail -1)
EVENT2_BODY=$(echo "$EVENT2_RES" | sed '$d')
EVENT2_ID=$(echo "$EVENT2_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

if [ -n "$EVENT2_ID" ]; then
  echo "    ✓ 생성 완료 (ID: $EVENT2_ID)"

  # 좌석 등급: 테이블석 (포인트추첨), 외야 지정석 (포인트추첨)
  curl -s -X POST "$API/events/$EVENT2_ID/tiers" \
    -H "Content-Type: application/json" -H "$AUTH" \
    -d '{
      "name": "테이블석",
      "capacity": 2000,
      "base_price": 150000,
      "sale_mode": "point_lottery",
      "face_price": 150000,
      "lottery_application_hours": 48,
      "view_description": "홈플레이트 뒤편 프리미엄 테이블석. 음식 배달 서비스 포함.",
      "distance_from_stage": 20,
      "view_rating": 5,
      "position_label": "홈 테이블석 T1-T40",
      "max_group_size": 4
    }' > /dev/null
  echo "    ✓ 테이블석 등급 (2,000석 / ₩150,000 / 포인트 추첨)"

  curl -s -X POST "$API/events/$EVENT2_ID/tiers" \
    -H "Content-Type: application/json" -H "$AUTH" \
    -d '{
      "name": "외야 지정석",
      "capacity": 18000,
      "base_price": 30000,
      "sale_mode": "point_lottery",
      "face_price": 30000,
      "lottery_application_hours": 48,
      "view_description": "1루/3루 외야 지정좌석. 응원단과 함께 열정적인 응원을 즐기세요.",
      "distance_from_stage": 100,
      "view_rating": 3,
      "position_label": "외야 1루/3루 블록",
      "max_group_size": 6
    }' > /dev/null
  echo "    ✓ 외야 지정석 등급 (18,000석 / ₩30,000 / 포인트 추첨)"
else
  echo "    ✗ 행사 2 생성 실패 ($EVENT2_HTTP): $EVENT2_BODY"
fi

# ── 4. 관리자로 featured 설정 ──────────────────────

echo ""
echo "[4/5] 관리자 로그인 → featured 설정..."

ADMIN_LOGIN=$(curl -s -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@pickket.kr", "password": "Admin1234!"}')
ADMIN_TOKEN=$(echo "$ADMIN_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

if [ -n "$ADMIN_TOKEN" ] && [ -n "$EVENT1_ID" ]; then
  curl -s -X PATCH "$API/events/$EVENT1_ID" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"is_featured": true}' > /dev/null
  echo "  ✓ IU 콘서트 → is_featured=true"
fi
if [ -n "$ADMIN_TOKEN" ] && [ -n "$EVENT2_ID" ]; then
  curl -s -X PATCH "$API/events/$EVENT2_ID" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"is_featured": true}' > /dev/null
  echo "  ✓ KBO 올스타전 → is_featured=true"
fi

# ── 5. 결과 확인 ──────────────────────────────────

echo ""
echo "[5/5] 최종 확인..."
echo ""

cd "$DOCKER_DIR"

echo "┌─ 계정 현황 ─────────────────────────────────────────────┐"
$DB_CMD -c "SELECT email, name, is_organizer, is_admin, is_verified FROM users ORDER BY created_at;" 2>/dev/null
echo "└─────────────────────────────────────────────────────────┘"

echo ""
echo "┌─ 행사 현황 ─────────────────────────────────────────────┐"
$DB_CMD -c "SELECT title, category, status, total_seats, min_price, is_featured FROM events ORDER BY created_at;" 2>/dev/null
echo "└─────────────────────────────────────────────────────────┘"

echo ""
echo "┌─ 좌석 등급 현황 ────────────────────────────────────────┐"
$DB_CMD -c "
SELECT e.title AS event, t.name AS tier, t.sale_mode, t.capacity, t.base_price
FROM seat_tiers t JOIN events e ON t.event_id = e.id
ORDER BY e.created_at, t.base_price DESC;" 2>/dev/null
echo "└─────────────────────────────────────────────────────────┘"

echo ""
echo "═══════════════════════════════════════════════"
echo " 시드 데이터 생성 완료!"
echo ""
echo " 테스트 계정:"
echo "   관리자   admin@pickket.kr     / Admin1234!"
echo "   주최자   organizer@pickket.kr / Organizer1234!"
echo "   사용자   user@pickket.kr      / User1234!"
echo ""
echo " 테스트 행사:"
echo "   1. IU 콘서트 (CONCERT / fixed_fcfs)"
echo "   2. KBO 올스타전 (SPORTS / point_lottery)"
echo "═══════════════════════════════════════════════"
