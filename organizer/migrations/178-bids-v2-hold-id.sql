-- 178: bids.v2_hold_id — 추첨 당첨 좌석의 v2 재고 HOLD 식별자 (감사 P1-11)
--
-- go-local 추첨(runLottery/allocateSeatsForBid)이 seats.status='lottery_held' 만 UPDATE 하고
-- v2 재고 SSOT 를 우회해, v2 는 해당 좌석을 여전히 available 로 보고 일반 체크아웃이 같은 좌석을
-- 판매할 수 있었다(크로스시스템 이중판매). 이를 막기 위해 배정 시 v2 holdInventory 로 좌석을
-- HELD 로 잠그고, 그 hold_id 를 당첨 bid 에 보관한다. 당첨자 체크아웃은 이 hold_id 를 bearer
-- 소유증명으로 createOrder(hold_id) 에 넘겨 claim 하고, 미결제 만료/미당첨 시 releaseInventory 로 해제한다.
ALTER TABLE bids ADD COLUMN IF NOT EXISTS v2_hold_id UUID NULL;
CREATE INDEX IF NOT EXISTS idx_bids_v2_hold_id ON bids(v2_hold_id) WHERE v2_hold_id IS NOT NULL;
