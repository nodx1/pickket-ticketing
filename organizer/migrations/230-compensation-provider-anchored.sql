-- 230: provider-앵커 보상(레벨2 재감사 P0조건부) — v2 앵커 없는 실결제의 자동환불 보장.
--
-- 배경: payment_compensation_actions.v2_order_id 는 196 이래 NOT NULL 이었다. 이 때문에
--   좌석만료(order-finalize)·Toss orphan(reconcile) 경로가 v2_order_id 가 없으면 보상 액션을
--   **아예 기록하지 못하고** console.error 로그만 남긴 채 스킵했다. 그 결과:
--     ① Toss 실결제(v2 앵커 없음, paymentKey 는 있음) — 좌석만료/go실패 시 자동환불 미보장(실돈 유실)
--     ② 레거시/NICE(paymentKey·v2 앵커 모두 없음) — 조용한 유실(수동검토 큐에도 안 들어감)
--
-- 사실: Toss 환불은 provider_payment_key(paymentKey) 만으로 가능하다(v2 앵커 불요). v2 환불만
--   v2_order_id 가 필요하다. 따라서 v2_order_id 를 nullable 로 풀면 Toss 보상은 앵커 없이도
--   durable 하게 기록·자동환불되고(옵션 a), 앵커·키 둘 다 없는 진짜 미환불건은 status='manual_review'
--   로 hard-record(옵션 b) 해 조용한 유실을 구조적으로 없앤다.
--
-- 가산적: 컬럼 제약 완화(NOT NULL 제거) + CHECK 로 "환불 가능 앵커 최소 하나" 불변식 신설.
--   기존 행(전부 v2_order_id 有)은 CHECK 를 자동 만족 → 재작성 없음.

-- 1) v2_order_id NOT NULL 완화. Toss 보상은 provider_payment_key 만으로 충분하다.
ALTER TABLE payment_compensation_actions
  ALTER COLUMN v2_order_id DROP NOT NULL;

-- 2) 환불 실행 가능성 불변식: 자동환불 대상(pending/processing/failed_retryable/unknown)은
--    최소한 하나의 provider 앵커가 있어야 한다.
--      - v2 provider  → v2_order_id 필수
--      - toss provider → provider_payment_key 필수
--    manual_review/failed/completed/cancelled 은 앵커 없이도 존재 가능(=수동 처리 큐/종료 상태).
--    → "환불 워커가 클레임했는데 부를 대상이 없음"이 구조적으로 불가능.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'payment_compensation_actions'::regclass
       AND conname = 'ck_payment_compensation_refund_anchor'
  ) THEN
    ALTER TABLE payment_compensation_actions
      ADD CONSTRAINT ck_payment_compensation_refund_anchor
      CHECK (
        status NOT IN ('pending', 'processing', 'failed_retryable', 'unknown')
        OR (provider_name = 'v2'   AND v2_order_id IS NOT NULL)
        OR (provider_name = 'toss' AND provider_payment_key IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN payment_compensation_actions.v2_order_id IS
  'v2 order anchor for v2-provider refunds. NULL is allowed for toss-provider actions (refunded via provider_payment_key) and for unrefundable manual_review records (no v2 anchor, no paymentKey).';
