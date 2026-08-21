-- 245: go accounts/users 를 참조하는 FK 전량 제거 (레벨2 컷오버 — 계정 도메인 v2 이관 완료분 반영)
--
-- 왜 필요한가
--   인증(로그인·회원가입)은 이미 **v2 가 SSOT** 다(레벨2 2차 D2 에서 go stub 조회·INSERT 제거).
--   회원가입은 v2 `users` + `organizer_profiles`(go_account_id = v2 user id)만 만들고
--   go `accounts`/`users` 에는 **아무 행도 만들지 않는다**.
--
--   그런데 go 앵커 테이블들(orders·attendees·products…)은 여전히 `account_id` 를 기록하며
--   그 컬럼에 `accounts(id)` FK 가 걸려 있다. 따라서 go accounts 를 비우거나 신규 가입자가
--   주문을 만들면 **FK 위반으로 주문 생성 자체가 실패**한다.
--
--   ⟹ 죽은 부모(accounts/users)에 대한 FK 를 끊는다. `account_id` **컬럼과 값은 그대로 유지**
--      하므로 테넌트 스코프 질의는 전부 정상 동작한다. 경계 강제는 이미 v2 `organizer_ref` 가 한다.
--
-- ⚠️ 이 마이그레이션은 go accounts/users TRUNCATE 의 **선행 조건**이다. 순서를 바꾸면
--    TRUNCATE 가 FK 때문에 실패하거나 CASCADE 로 전 테이블이 함께 지워진다.
--
-- 🔧 2026-07-27 정정 (prod 실행 중 실패해 재작성)
--    최초 버전은 제약명을 하드코딩한 `ALTER TABLE <t> DROP CONSTRAINT IF EXISTS <c>` 58줄이었다.
--    `IF EXISTS` 는 **제약**에만 적용되고 **테이블 부재는 막지 못한다** — 앞선 마이그(233·237·
--    238a·238b·240·243)가 이미 지운 테이블(allocation_sessions·crm_contacts·bids·organizers·
--    sale_phases·tax_invoices·seat_funnel_events·crm_activities·event_organizers)에서
--    `relation "..." does not exist` 로 전체가 실패했다.
--    ⟹ 하드코딩을 버리고 **pg_catalog 를 조회해 실제 존재하는 FK 만** 끊는다.
--       적용 순서·앞선 DROP 여부와 무관하게 항상 옳고, 재실행에도 안전하다.

BEGIN;

DO $$
DECLARE
  dead_parents text[] := ARRAY['accounts', 'users'];
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

  RAISE NOTICE '245: accounts/users 참조 FK % 개 제거', dropped;
END $$;

-- 검증: accounts/users 를 참조하는 FK 가 0 이어야 한다.
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM pg_constraint con
  JOIN pg_class pcl ON pcl.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = pcl.relnamespace
  WHERE con.contype = 'f'
    AND ns.nspname = 'public'
    AND pcl.relname IN ('accounts', 'users');

  IF remaining > 0 THEN
    RAISE EXCEPTION '245: accounts/users 참조 FK 가 % 개 남았다 — TRUNCATE 전에 해소해야 한다', remaining;
  END IF;
END $$;

COMMIT;
