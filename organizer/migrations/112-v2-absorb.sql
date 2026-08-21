-- 도메인별 메타데이터 (스포츠/클래식/축제 등)
ALTER TABLE events ADD COLUMN IF NOT EXISTS domain_metadata JSONB DEFAULT '{}';
COMMENT ON COLUMN events.domain_metadata IS '도메인별 추가 필드: {homeTeam, awayTeam, broadcast} 등';

-- 리세일/잔여 정책
ALTER TABLE events ADD COLUMN IF NOT EXISTS resale_enabled BOOLEAN DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS resale_max_markup_pct INT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS resale_royalty_pct INT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS remainder_strategy TEXT DEFAULT 'none'
  CHECK (remainder_strategy IN ('discount_fcfs', 'fcfs', 'lottery', 'none'));

COMMENT ON COLUMN events.resale_enabled IS '리세일 허용 여부';
COMMENT ON COLUMN events.remainder_strategy IS '잔여석 처리 전략';

-- 할인 유형 확장
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS discount_type TEXT DEFAULT 'code'
  CHECK (discount_type IN ('code', 'member', 'card', 'early_bird', 'student', 'group', 'senior', 'other'));
COMMENT ON COLUMN promo_codes.discount_type IS '할인 유형: code=프로모코드, member=회원, card=카드사 등';

-- 이벤트 타입 24종 확장
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_event_type_check;
ALTER TABLE events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
  'concert', 'festival', 'conference', 'exhibition', 'mice', 'workshop',
  'fan_meeting', 'flea_market', 'lecture', 'preview', 'local_festival',
  'party', 'networking', 'sports',
  'musical', 'theater', 'comedy', 'seminar', 'meetup', 'webinar',
  'trade_show', 'charity', 'awards', 'screening'
));
