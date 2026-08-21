-- C-1 Waitlist "구매 제안" 실구현.
--   converted_order_id: offered → converted 시 생성된 go 주문(orders.id) 앵커. 중복 전환 차단·추적.
--   offer_token_version: 재발송(재-offer) 시 증가시켜 이전 딥링크 토큰을 무효화한다.
-- 가산적 마이그레이션(IF NOT EXISTS) — 롤백 = DROP COLUMN.
ALTER TABLE waitlist_entries
  ADD COLUMN IF NOT EXISTS converted_order_id UUID NULL REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offer_token_version INTEGER NOT NULL DEFAULT 0;
