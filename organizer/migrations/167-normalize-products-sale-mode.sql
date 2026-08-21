-- G2 (DB 재설계): products.sale_mode 를 v2 canonical 4종으로 정규화.
--
-- 배경: migration 110 이 products.sale_mode CHECK 를 레거시('fcfs/vcg/lottery/dutch')로
-- 걸었고, 데이터·sync 가 레거시 값으로 흘러 v2 canonical(fixed_fcfs/point_lottery/
-- fanclub_presale/queue)과 어긋남. v2 가 단계6에서 동일 CHECK 를 seat_tiers/tickets 에
-- 걸 예정 → go 송신값이 4종이어야 통과.
--
-- 매핑(= domain-model.ts toCanonicalSaleMode): fcfs→fixed_fcfs, lottery→point_lottery,
--   vcg→point_lottery(lossy: 경매→추첨), dutch→fixed_fcfs(lossy).
--
-- ⚠️ 순서 중요: 레거시 CHECK 를 먼저 제거해야 새 canonical 값으로 UPDATE 가능.

-- 1) 레거시 CHECK 제거 (이걸 먼저 — 안 그러면 canonical UPDATE 가 구 CHECK 에 막힘)
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sale_mode_check;

-- 2) 기존 데이터 정규화
UPDATE products SET sale_mode = 'fixed_fcfs'    WHERE sale_mode = 'fcfs';
UPDATE products SET sale_mode = 'point_lottery' WHERE sale_mode IN ('lottery', 'vcg');
UPDATE products SET sale_mode = 'fixed_fcfs'    WHERE sale_mode = 'dutch';

-- 3) v2 4종 CHECK 재설정
ALTER TABLE products
  ADD CONSTRAINT products_sale_mode_check
  CHECK (sale_mode IN ('fixed_fcfs', 'point_lottery', 'fanclub_presale', 'queue'));

-- 4) 기본값을 canonical 로
ALTER TABLE products ALTER COLUMN sale_mode SET DEFAULT 'fixed_fcfs';
