-- 이벤트에 연결된 팬클럽 (멤버십 선판매용).
--
-- v2 의 fanclubs.id 를 참조 (FK 아님 — 크로스 서비스). v2 가 팬클럽 데이터 SSOT.
-- 주최자가 이벤트 설정 시 자기 소유 팬클럽을 선택하면 이 컬럼에 저장.
-- membership_presale sale_phase 생성 시 phase.config.fanclub_id 로 복사됨 → v2 추첨 시 해당 팬클럽 회원만 응모 허용.
--
-- NULL 이면 멤버십 선판매 미사용.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS fanclub_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_events_fanclub_id
  ON events (fanclub_id) WHERE fanclub_id IS NOT NULL;

COMMENT ON COLUMN events.fanclub_id IS
  'v2 fanclubs.id 참조. membership_presale 응모 시 해당 팬클럽 회원만 허용. NULL = 미연결.';
