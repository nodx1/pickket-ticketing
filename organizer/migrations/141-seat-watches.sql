-- 트랙 1.9 — 좌석 즐겨찾기 + 가격 알림
--
-- 사용자가 매진/사라진 좌석을 추적할 수 있게 한다.
-- - target_price: NULL 이면 단순 즐겨찾기 (refund 로 좌석 풀리면 알림)
--                 값 있으면 dutch/lottery 등에서 가격이 도달하면 알림
-- - notify_at: 마지막 알림 발송 시각 (중복 알림 방지)
--
-- 비로그인 사용자를 위해 session_id (cookie) 도 허용. 로그인 사용자는 user_id 로 sync.

CREATE TABLE IF NOT EXISTS seat_watches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       UUID NULL,
  session_id    TEXT NULL,
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seat_id       UUID NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  target_price  BIGINT NULL,
  notify_at     TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seat_watches_owner_check
    CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_seat_watches_user_seat
  ON seat_watches(user_id, seat_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_seat_watches_session_seat
  ON seat_watches(session_id, seat_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seat_watches_event ON seat_watches(event_id);
CREATE INDEX IF NOT EXISTS idx_seat_watches_seat ON seat_watches(seat_id);
CREATE INDEX IF NOT EXISTS idx_seat_watches_notify_at
  ON seat_watches(notify_at)
  WHERE notify_at IS NULL;

COMMENT ON TABLE seat_watches IS
  '좌석 즐겨찾기/가격 알림 — refund/dutch 가격 변동 시 푸시.';
COMMENT ON COLUMN seat_watches.target_price IS
  'NULL=단순 즐겨찾기. 값 있으면 가격 ≤ target 도달 시 알림.';
COMMENT ON COLUMN seat_watches.notify_at IS
  '마지막 알림 발송 시각. NULL=미발송.';
