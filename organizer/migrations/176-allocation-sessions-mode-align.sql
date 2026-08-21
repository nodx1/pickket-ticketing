-- =============================================================================
-- 실증 G3 — allocation_sessions.mode CHECK 정렬 (금지어 제거 + 실제 어휘 허용)
--
-- 배경: 라운드2 완전체 실증에서 fanclub_presale(membership_presale) phase open 영구 불가 발견.
--   openPhase(sale-plan/service.ts)가 phase.mode 를 allocation_sessions.mode 로 INSERT 하는데,
--   allocation_sessions_mode_check 가 레거시 4종(vcg/lottery/dutch/fcfs)만 허용 →
--   membership_presale/queue_sale/waitlist_promotion/fcfs_residual INSERT 시 CHECK 위반(23514)으로
--   HTTP400, fanclub/queue 응모 도달 불가.
--
-- 추가 문제: 기존 CHECK 의 'vcg'·'dutch' 는 DOMAIN_MODEL_STANDARD 금지 용어(VCG경매/더치옥션).
--   정본 sale_phases.mode CHECK 어휘(membership_presale/lottery/waitlist_promotion/queue_sale/
--   fcfs_residual)로 정렬해 금지어 제거 + 실제 phase.mode 와 일치시킨다.
-- =============================================================================

ALTER TABLE allocation_sessions DROP CONSTRAINT IF EXISTS allocation_sessions_mode_check;

ALTER TABLE allocation_sessions
  ADD CONSTRAINT allocation_sessions_mode_check
  CHECK (mode = ANY (ARRAY[
    'membership_presale'::text,
    'lottery'::text,
    'waitlist_promotion'::text,
    'queue_sale'::text,
    'fcfs_residual'::text
  ]));
