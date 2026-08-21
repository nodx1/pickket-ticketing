-- 빅뱅 flip — seats 앵커화 (재고 write-through 토대)
-- seats.v2_seat_id = v2 canonical seat UUID. repo.ts hold/release/block이 이걸 키로 v2 재고 API 호출.
-- ⚠️ 데이터 채움은 v2 upsertSeats가 좌석별 canonical seat_id 매핑을 반환해야 가능(현재 {count}만 — v2 보강 대기).
BEGIN;
ALTER TABLE seats ADD COLUMN IF NOT EXISTS v2_seat_id UUID;
CREATE INDEX IF NOT EXISTS idx_seats_v2_seat_id ON seats (v2_seat_id);
COMMIT;
