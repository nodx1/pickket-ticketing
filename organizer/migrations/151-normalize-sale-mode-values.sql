-- sale_mode 레거시 값 → docs canonical 값으로 정규화.
--
-- docs/architecture/SALE_MODE_POLICY_v2 canonical:
--   membership_presale | lottery | queue_sale | fcfs_residual
--
-- 매핑:
--   fixed_fcfs    → fcfs_residual
--   dutch         → fcfs_residual (더치 옥션 → 가장 가까운 잔여 선착순)
--   vcg           → lottery        (VCG 경매 → 가중치 추첨 대체)
--   weighted      → lottery
--   group_lottery → lottery
--
-- 이미 canonical 인 값(lottery, fcfs_residual 등) 은 그대로 유지.

UPDATE seat_tiers
SET sale_mode = CASE sale_mode
  WHEN 'fixed_fcfs'    THEN 'fcfs_residual'
  WHEN 'dutch'         THEN 'fcfs_residual'
  WHEN 'vcg'           THEN 'lottery'
  WHEN 'weighted'      THEN 'lottery'
  WHEN 'group_lottery' THEN 'lottery'
  ELSE sale_mode
END
WHERE sale_mode IN ('fixed_fcfs','dutch','vcg','weighted','group_lottery');

-- allocation_sessions.mode 도 동일 매핑 (기존 테스트 세션 호환)
UPDATE allocation_sessions
SET mode = CASE mode
  WHEN 'fcfs'   THEN 'fcfs_residual'
  WHEN 'dutch'  THEN 'fcfs_residual'
  WHEN 'vcg'    THEN 'lottery'
  WHEN 'weighted' THEN 'lottery'
  ELSE mode
END
WHERE mode IN ('fcfs','dutch','vcg','weighted');
