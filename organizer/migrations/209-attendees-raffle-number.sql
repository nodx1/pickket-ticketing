-- F4 경품번호: attendees 에 raffle_number(v2 발권 시 부여된 경품 응모번호) 표시용 캐시 추가.
-- 정본은 v2 tickets.raffle_number(이벤트 스코프 유니크). go 는 발권 응답(createOrder.raffle_numbers)에서
-- v2_ticket_id 로 매핑해 이 컬럼에 미러링한다(표시·초대권용, F5 UI 가 소비).
-- 가산적(nullable). raffle 미활성 이벤트/기존 발권은 NULL 로 남고 동작 불변(하위호환).
ALTER TABLE attendees
  ADD COLUMN IF NOT EXISTS raffle_number INT;
