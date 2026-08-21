-- 255: orders.refund_notified_at — 환불완료 통지 멱등 표식
--
-- ## 왜
-- 환불완료 알림(알림톡·이메일)에 **"이 주문에 이미 보냈는가" 를 아는 장치가 없다.**
-- 발송 계층의 `idempotencyKey`(`ncp/client.ts`)는 provider 재시도용 attempt key 이고,
-- 웹훅의 SETNX + ON CONFLICT 는 **같은 delivery_id** 만 막는다. 다른 delivery_id 로
-- 재전달되면 구매자가 환불완료 안내를 또 받는다.
--
-- ## 왜 Redis 가 아니라 컬럼인가
--   · "이미 통지했다" 는 **영구 사실**이다. TTL 만료 = 그 사실이 사라짐 → 늦은 재전달에
--     손님이 또 받는다. Redis 는 재시작·flush 로도 소실되고 백업 대상이 아니다.
--   · "보냈다는데 못 받았다" 분쟁에서 Redis 키는 근거가 안 된다(대회 후 CS).
--   · 새 테이블 대신 컬럼인 이유: state-changed 가 이미 `orders` 를 트랜잭션 안에서
--     읽고 쓴다(조회 왕복 0). go DB 는 v2 통합 때 사라지므로 이관 표면도 작다.
--
-- ## 🔴 사용 규약 — 선점 후 발송, 실패 시 해제
--   발송 **전**에 표식하면 발송 실패 시 영영 안 간다(더 나쁜 실패).
--   발송 **후**에 표식하면 동시 도착 시 둘 다 발송된다.
--   ⟹ 조건부 UPDATE 로 **선점**하고, 실패하면 NULL 로 되돌린다.
--
--     UPDATE orders SET refund_notified_at = NOW()
--      WHERE id = $1 AND refund_notified_at IS NULL
--      RETURNING id;          -- 0행이면 다른 요청이 보내는 중 → 조용히 skip
--
--   같은 리포의 `payment_confirm_outbox.lease_token` 과 같은 모양이다.
--
-- ## 온라인 안전성
-- NULL 허용 컬럼 추가는 테이블 재작성·락이 없다. 옛 코드는 이 컬럼을 무시하므로
-- **코드보다 먼저 독립 적용해도 안전**하다.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS refund_notified_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN orders.refund_notified_at IS
  '환불완료 통지 발송 시각. NULL=미발송. 조건부 UPDATE 로 선점하고 발송 실패 시 NULL 로 되돌린다(255).';
