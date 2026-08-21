-- 254: payment_confirm_outbox 에 종결 상태 'superseded' 추가 (지시서 #4 T9)
--
-- 배경(prod 실측): 아웃박스가 pending 인 사이에 v2 주문이 종결 상태(refunded/cancelled 등)에
--   도달하면, 그 행은 **원리적으로 confirm 될 수 없는데 계속 재시도**한다.
--   v2 전이표(order.py:VALID_ORDER_TRANSITIONS) 상 CONFIRMED 로 갈 수 있는 출발 상태는
--   PENDING·PAYMENT_REQUIRED·AUTHORIZED 뿐이고, CANCELLED/EXPIRED/REFUNDED/DEPOSIT_* 는
--   나가는 전이가 아예 없다. 그래서 v2 는 매번 422 STATE_TRANSITION_FORBIDDEN 을 돌려주고,
--   드레인은 attempts 를 소진해 결국 manual_review 로 보낸다(운영자가 정상 취소건을 조사).
--
-- 판매가 시작되면 "결제 직후 즉시 취소/환불"마다 반복된다 — 드레인 주기보다 고객 취소가
--   빠른 건 흔하다.
--
-- 왜 새 상태인가:
--   · 'confirmed' 로 쓰면 **확정된 적 없는 주문이 확정으로 집계**된다(재무 왜곡).
--   · 'failed' / 'manual_review' 로 쓰면 **정상 취소가 실패 목록을 오염**시켜
--     운영자가 진짜 실패를 못 본다.
--   ⟹ "확정이 더 이상 유효하지 않아 폐기됨"을 뜻하는 독립 종결 상태가 정확하다.
--
-- 가산적·멱등. 드레인 스캔 조건은 status IN ('pending','failed') 이라 새 상태는 자동 제외된다.

ALTER TABLE payment_confirm_outbox
  DROP CONSTRAINT IF EXISTS ck_payment_confirm_outbox_status;

ALTER TABLE payment_confirm_outbox
  ADD CONSTRAINT ck_payment_confirm_outbox_status
  CHECK (status IN ('pending', 'confirmed', 'failed', 'manual_review', 'superseded'));
