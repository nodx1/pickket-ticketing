-- 성능: 공개/조인 경로의 풀스캔 제거 (전수 감사 P5)
--
-- 1) events.slug 단독 인덱스
--    기존 인덱스는 UNIQUE(account_id, slug) 뿐 — 선두 컬럼이 account_id 라
--    공개 라우트의 `WHERE slug = $1` (account_id 없음) 조회에 사용 불가 → events 풀스캔.
--    공개 이벤트 페이지/좌석 스냅샷/SSE 핸드셰이크 등 최다 트래픽 경로.
CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);

-- 2) attendees.order_item_id 인덱스
--    FK 이지만 Postgres 는 FK 에 자동 인덱스를 만들지 않음.
--    참석자 목록/CSV 가 `INNER JOIN order_items ON order_items.id = attendees.order_item_id`
--    로 상품명을 조인 → attendees 측 조인 키 인덱스 부재로 대형 테이블 전량 스캔.
CREATE INDEX IF NOT EXISTS idx_attendees_order_item_id
  ON attendees(order_item_id) WHERE order_item_id IS NOT NULL;

-- 참고: attendees.ticket_number 는 컬럼 정의의 UNIQUE 제약으로 이미 암시적
-- 유니크 인덱스가 존재하므로 별도 인덱스 불필요 (감사 중 확인됨).
