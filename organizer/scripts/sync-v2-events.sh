#!/bin/bash
# v2 이벤트를 go DB로 동기화 (Opus 4.7 C2 대응 — psql -v 변수 바인딩)
# 사용: bash scripts/sync-v2-events.sh
#
# 보안: 이전 버전은 셸 변수 보간으로 psql -c에 값을 직접 삽입 → SQL 주입 벡터.
# 이 버전은 psql -v + :'name' 변수 바인딩으로 완전 파라미터화.
#
# 부분 동기화 방어: 이벤트 + 상품을 한 psql 세션 + 단일 트랜잭션으로 묶음.

set -e

: "${GO_DB_HOST:?GO_DB_HOST 환경변수가 필요합니다}"
: "${GO_DB_PORT:=5434}"
: "${GO_DB_USER:?GO_DB_USER 환경변수가 필요합니다}"
: "${GO_DB_PASS:?GO_DB_PASS 환경변수가 필요합니다}"
: "${GO_DB_NAME:?GO_DB_NAME 환경변수가 필요합니다}"
: "${GO_ACCOUNT_ID:?GO_ACCOUNT_ID 환경변수가 필요합니다}"

echo "=== v2 → go 이벤트 동기화 ==="

# go DB 연결 래퍼: 모든 UPSERT를 psql 변수 바인딩으로 호출
run_psql() {
  PGPASSWORD="$GO_DB_PASS" psql \
    -h "$GO_DB_HOST" -p "$GO_DB_PORT" -U "$GO_DB_USER" -d "$GO_DB_NAME" \
    -v ON_ERROR_STOP=1 -q "$@"
}

# SSH 터널로 v2 DB 데이터 추출 (v2 측은 읽기 전용이므로 주입 벡터 없음)
V2_EVENTS=$(ssh desktop "docker exec pickket-v2-db psql -U pickket_v2 -d pickket_v2_dev -t -A -F'|' -c \"
SELECT
  e.id,
  REGEXP_REPLACE(e.title, E'[\r\n]+', ' ', 'g'),
  LOWER(REPLACE(REPLACE(e.title, ' ', '-'), '[테스트]', 'test')),
  REGEXP_REPLACE(COALESCE(e.description, ''), E'[\r\n]+', ' ', 'g'),
  REGEXP_REPLACE(COALESCE(e.venue, ''), E'[\r\n]+', ' ', 'g'),
  e.event_date,
  e.event_date + INTERVAL '3 hours',
  CASE e.status::text
    WHEN 'DRAFT' THEN 'draft'
    WHEN 'BIDDING_OPEN' THEN 'live'
    WHEN 'BIDDING_CLOSED' THEN 'paused'
    WHEN 'CANCELLED' THEN 'archived'
    ELSE 'draft'
  END,
  COALESCE(e.category, 'concert'),
  COALESCE(e.image_url, ''),
  e.total_seats,
  e.current_phase,
  e.bidding_opens_at,
  e.bidding_closes_at,
  e.min_price,
  e.max_price
FROM events e
ORDER BY e.created_at;
\"" 2>/dev/null)

if [ -z "$V2_EVENTS" ]; then
  echo "v2 이벤트를 가져올 수 없습니다."
  exit 1
fi

# 임시 SQL 파일에 전체 UPSERT를 누적 → 단일 트랜잭션으로 실행 (부분 동기화 방지)
TMP_SQL=$(mktemp --suffix=.sql)
trap 'rm -f "$TMP_SQL"' EXIT

{
  echo "BEGIN;"
} > "$TMP_SQL"

COUNT=0
while IFS='|' read -r v2id title slug desc venue starts_at ends_at status category image_url total_seats phase bidding_opens bidding_closes min_price max_price; do
  [ -z "$v2id" ] && continue

  # slug 정리 (한글 제거, 특수문자 제거) — 셸 레벨 정규화 (값 자체가 주입 벡터가 아닌 psql 변수로 전달되므로 안전)
  clean_slug=$(echo "$slug" | sed 's/[^a-z0-9-]//g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  [ -z "$clean_slug" ] && clean_slug="v2-event-$(echo "$v2id" | cut -c1-8)"
  final_slug="${clean_slug}-$(echo "$v2id" | cut -c1-8)"

  # category 정규화
  category_lower=$(echo "$category" | tr 'A-Z' 'a-z')
  case "$category_lower" in
    concert|festival|conference|exhibition|mice|workshop|fan_meeting|flea_market|lecture|preview|local_festival|party|networking|sports|musical|theater|comedy|seminar|meetup|webinar|trade_show|charity|awards|screening)
      go_event_type="$category_lower" ;;
    *)
      go_event_type="concert" ;;
  esac

  # 빈 값 → NULL 변환을 psql 측에서 처리 (NULLIF)
  # psql \set 명령으로 변수 주입 — :'var' 형식으로 안전하게 바인딩됨
  {
    echo "\\set v2id '$(printf '%s' "$v2id" | sed "s/'/''/g")'"
    echo "\\set account_id '$(printf '%s' "$GO_ACCOUNT_ID" | sed "s/'/''/g")'"
    echo "\\set title '$(printf '%s' "$title" | sed "s/'/''/g")'"
    echo "\\set slug '$(printf '%s' "$final_slug" | sed "s/'/''/g")'"
    echo "\\set description '$(printf '%s' "$desc" | sed "s/'/''/g")'"
    echo "\\set venue '$(printf '%s' "$venue" | sed "s/'/''/g")'"
    echo "\\set starts_at '$(printf '%s' "$starts_at" | sed "s/'/''/g")'"
    echo "\\set ends_at '$(printf '%s' "$ends_at" | sed "s/'/''/g")'"
    echo "\\set status '$(printf '%s' "$status" | sed "s/'/''/g")'"
    echo "\\set event_type '$(printf '%s' "$go_event_type" | sed "s/'/''/g")'"
    echo "\\set image_url '$(printf '%s' "$image_url" | sed "s/'/''/g")'"
    echo "\\set total_seats '$(printf '%s' "$total_seats" | sed "s/'/''/g")'"
    echo "\\set phase '$(printf '%s' "${phase:-general_sale}" | sed "s/'/''/g")'"
    echo "\\set bidding_opens '$(printf '%s' "$bidding_opens" | sed "s/'/''/g")'"
    echo "\\set bidding_closes '$(printf '%s' "$bidding_closes" | sed "s/'/''/g")'"

    cat <<'SQL'
INSERT INTO events (
  id, account_id, title, slug, description, venue_name,
  starts_at, ends_at, timezone, status, event_type,
  hero_image_url, max_attendees, current_phase,
  bidding_opens_at, bidding_closes_at,
  created_at, updated_at
) VALUES (
  :'v2id'::uuid, :'account_id'::uuid,
  :'title', :'slug', :'description', :'venue',
  COALESCE(NULLIF(:'starts_at', '')::timestamptz, NOW()),
  COALESCE(NULLIF(:'ends_at', '')::timestamptz, NOW() + INTERVAL '3 hours'),
  'Asia/Seoul',
  :'status', :'event_type',
  NULLIF(:'image_url', ''),
  NULLIF(:'total_seats', '')::int,
  :'phase',
  NULLIF(:'bidding_opens', '')::timestamptz,
  NULLIF(:'bidding_closes', '')::timestamptz,
  NOW(), NOW()
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  status = EXCLUDED.status,
  current_phase = EXCLUDED.current_phase,
  updated_at = NOW();
SQL
  } >> "$TMP_SQL"

  COUNT=$((COUNT+1))
  echo "  ✅ $title ($status)"
done <<< "$V2_EVENTS"

# v2 seat_tiers → go products 동기화
echo ""
echo "=== v2 seat_tiers → go products ==="

V2_TIERS=$(ssh desktop "docker exec pickket-v2-db psql -U pickket_v2 -d pickket_v2_dev -t -A -F'|' -c \"
SELECT
  st.id,
  st.event_id,
  REGEXP_REPLACE(st.name, E'[\r\n]+', ' ', 'g'),
  REGEXP_REPLACE(COALESCE(st.view_description, ''), E'[\r\n]+', ' ', 'g'),
  st.base_price,
  st.capacity,
  COALESCE(st.face_price, st.base_price),
  COALESCE(st.sale_mode, 'fixed_fcfs')
FROM seat_tiers st
ORDER BY st.event_id, st.id;
\"")

TCOUNT=0
while IFS='|' read -r tid event_id name desc base_price capacity face_price sale_mode; do
  [ -z "$tid" ] && continue

  case "$sale_mode" in
    fcfs|fixed_fcfs|fanclub_presale) go_sale_mode="fcfs" ;;
    lottery|point_lottery|deposit_draw) go_sale_mode="lottery" ;;
    auction|point_auction|vcg) go_sale_mode="vcg" ;;
    dutch_auction|dutch) go_sale_mode="dutch" ;;
    *)
      echo "  ⚠️ 알 수 없는 sale_mode '$sale_mode' → fcfs로 폴백"
      go_sale_mode="fcfs" ;;
  esac

  base_price_clean=$(printf '%s' "$base_price" | sed 's/\.00$//')
  face_price_clean=$(printf '%s' "${face_price:-$base_price}" | sed 's/\.00$//')

  {
    echo "\\set tid '$(printf '%s' "$tid" | sed "s/'/''/g")'"
    echo "\\set account_id '$(printf '%s' "$GO_ACCOUNT_ID" | sed "s/'/''/g")'"
    echo "\\set event_id '$(printf '%s' "$event_id" | sed "s/'/''/g")'"
    echo "\\set name '$(printf '%s' "$name" | sed "s/'/''/g")'"
    echo "\\set description '$(printf '%s' "$desc" | sed "s/'/''/g")'"
    echo "\\set base_price '$(printf '%s' "$base_price_clean" | sed "s/'/''/g")'"
    echo "\\set face_price '$(printf '%s' "$face_price_clean" | sed "s/'/''/g")'"
    echo "\\set capacity '$(printf '%s' "$capacity" | sed "s/'/''/g")'"
    echo "\\set sale_mode '$(printf '%s' "$go_sale_mode" | sed "s/'/''/g")'"

    cat <<'SQL'
INSERT INTO products (
  id, account_id, event_id, name, description,
  type, visibility, price, face_price, capacity, sale_mode,
  is_active, created_at, updated_at
) VALUES (
  :'tid'::uuid, :'account_id'::uuid, :'event_id'::uuid,
  :'name', :'description',
  'ticket', 'public',
  :'base_price'::bigint,
  :'face_price'::bigint,
  NULLIF(:'capacity', '')::int,
  :'sale_mode',
  true, NOW(), NOW()
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price = EXCLUDED.price,
  capacity = EXCLUDED.capacity,
  sale_mode = EXCLUDED.sale_mode,
  updated_at = NOW();
SQL
  } >> "$TMP_SQL"

  TCOUNT=$((TCOUNT+1))
  echo "  ✅ $name (₩${base_price_clean} / $go_sale_mode / cap:${capacity:-∞})"
done <<< "$V2_TIERS"

echo "COMMIT;" >> "$TMP_SQL"

# 단일 psql 세션에서 트랜잭션 실행 — 실패 시 전체 롤백
echo ""
echo "=== 트랜잭션 커밋 중... ==="
run_psql -f "$TMP_SQL"

echo ""
echo "=== 동기화 완료: 이벤트 ${COUNT}개, 상품 ${TCOUNT}개 ==="
