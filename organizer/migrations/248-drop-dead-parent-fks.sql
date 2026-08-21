-- 248: **죽은 부모 테이블**을 참조하는 FK 전량 제거 (레벨2 컷오버 — 초기화 선행조건 마무리)
--
-- 배경
--   245 는 accounts/users, 246 은 events 에 대해 같은 일을 했다. 그런데 실측해 보니 같은 부류가
--   더 있다. "죽은 부모" = 애플리케이션이 **더 이상 INSERT 하지 않는** go 테이블이다.
--   초기화 후 그 테이블들은 영원히 비어 있는데, 아직 write 되는 자식들이 FK 로 그 부모를
--   요구하면 **INSERT 가 FK 위반으로 실패**한다.
--
-- 실측 (organizer/src, 테스트 제외 — `INSERT INTO <t>` writer 수)
--   products          writer 0   ← 상품 정본이 v2 tier 카탈로그로 이동(W2-PS)
--   seats             writer 0   ← 좌석 write 컷오버(T1)
--   seat_maps         writer 0   ← 〃
--   seat_tiers        writer 0   ← 유일 writer `lib/seats/tier-repo.ts` 는 index 재수출만 남은 死코드
--                                  (`tierRepo` 실사용처 grep 0건)
--   organizers        writer 0   ← v2 event_hosts 로 이관(W2-EVT)
--   event_organizers  writer 0   ← 〃 event_host_links
--   sale_phases       writer 0   ← v2 phase_configs 로 이관(T2-PHASE)
--
--   구체적 파손 예: `waitlist_entries.product_id → products(id)`,
--   `group_bookings.product_id → products(id)`, `seat_watches.seat_id → seats(id)` 는
--   자식이 여전히 write 되므로 초기화된 DB 에서 즉시 FK 위반이 난다.
--
-- 무엇을 남기는가 (의도적)
--   **산 부모 간 FK 는 남긴다** — 특히 `orders → attendees`, `orders → order_items`,
--   `orders → payment_*` 계열. 이들에는 ON DELETE CASCADE 가 걸려 있어, 무턱대고 지우면
--   주문 정리 시 자식이 남는 **조용한 고아 데이터**가 생긴다. 죽은 부모만 골라 끊는다.
--
-- ⚠️ 이 마이그레이션은 go 데이터 TRUNCATE 의 선행 조건이다(245·246 과 함께).
-- 재실행 안전: 동적 DROP + IF EXISTS.

BEGIN;

DO $$
DECLARE
  dead_parents text[] := ARRAY[
    'products', 'seats', 'seat_maps', 'seat_tiers',
    'organizers', 'event_organizers', 'sale_phases'
  ];
  r record;
  dropped int := 0;
BEGIN
  FOR r IN
    SELECT con.conname, cl.relname AS child_table
    FROM pg_constraint con
    JOIN pg_class cl  ON cl.oid  = con.conrelid
    JOIN pg_class pcl ON pcl.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE con.contype = 'f'
      AND ns.nspname = 'public'
      AND pcl.relname = ANY(dead_parents)
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', r.child_table, r.conname);
    dropped := dropped + 1;
  END LOOP;

  RAISE NOTICE '248: 죽은 부모 참조 FK % 개 제거', dropped;
END $$;

-- 검증: 죽은 부모를 참조하는 FK 가 0 이어야 한다.
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM pg_constraint con
  JOIN pg_class pcl ON pcl.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = pcl.relnamespace
  WHERE con.contype = 'f'
    AND ns.nspname = 'public'
    AND pcl.relname IN ('products','seats','seat_maps','seat_tiers',
                        'organizers','event_organizers','sale_phases');

  IF remaining > 0 THEN
    RAISE EXCEPTION '248: 죽은 부모 참조 FK 가 % 개 남았다', remaining;
  END IF;
END $$;

COMMIT;
