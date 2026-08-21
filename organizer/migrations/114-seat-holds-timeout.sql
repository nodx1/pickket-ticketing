-- Phase 5A-4: 좌석 홀드 타임아웃
-- v2 컬럼명 맞춤: backend/app/repositories/seat_repo.py
--
-- 현재 go는 createOrder 시점에 seats.status = 'reserved'로 확정.
-- 주문(expires_at 15분) 만료되어도 좌석은 reserved로 남아 다른 구매자 불가.
-- 이번 변경: held_until/held_by 컬럼 + reaper가 주기적 릴리즈.

ALTER TABLE seats
  ADD COLUMN IF NOT EXISTS held_until TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS held_by TEXT NULL;

COMMENT ON COLUMN seats.held_until IS
  '좌석 홀드 만료 시각. NULL=홀드 없음. reaper가 < NOW() 레코드 릴리즈.';
COMMENT ON COLUMN seats.held_by IS
  '홀드 보유자 식별자. go는 session_id(게스트 포함), v2는 user UUID. v2와 동일 컬럼명.';

CREATE INDEX IF NOT EXISTS idx_seats_held_until
  ON seats(held_until)
  WHERE held_until IS NOT NULL;
