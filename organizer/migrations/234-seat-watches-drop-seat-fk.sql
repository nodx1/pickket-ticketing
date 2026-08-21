-- 레벨2 컷오버 T1 — seat_watches.seat_id 의 go seats FK 제거.
-- 채번: 232(payment-compensation-attempt-idempotency)까지 점유 → 233 사용.
--
-- ── 안 하면 생기는 일 ──
-- 좌석 정본이 v2 로 넘어가면서 `seat_watches.seat_id` 에 들어가는 값이
-- **v2 canonical seat_id** 로 바뀐다. 그런데 mig141 이 걸어둔
--   seat_id UUID NOT NULL REFERENCES seats(id) ON DELETE CASCADE
-- 는 go `seats` 를 참조한다. go `seats` 는 좌석빌더 write 경로가 사라져 **항상 빈 테이블**이므로,
-- 관심좌석 등록(POST /api/public/events/{slug}/seats/watch)의 INSERT 가 전부
-- foreign key violation(23503) → 500 으로 실패한다.
--
-- ── 가산/멱등 ──
-- 제약 DROP 만 수행(데이터 무변경). IF EXISTS 라 재실행 안전.
-- 제약명은 mig141 이 명시하지 않아 PostgreSQL 기본 규칙(`{table}_{column}_fkey`)으로 생성됐다.
-- 혹시 다른 이름으로 생성된 환경이 있어도 남지 않도록, seat_watches.seat_id 를 참조하는
-- 모든 FK 를 카탈로그에서 찾아 지운다(같은 결과로 수렴).
--
-- ── 롤백 ──
-- go seats 를 되살리지 않는 한 FK 재생성은 불가(참조 대상이 비어 있음).
-- 되돌려야 하면: ALTER TABLE seat_watches ADD CONSTRAINT seat_watches_seat_id_fkey
--   FOREIGN KEY (seat_id) REFERENCES seats(id) ON DELETE CASCADE;  ← 기존 v2 id 행은 먼저 삭제 필요.
--
-- ℹ️ 인덱스(idx_seat_watches_seat)·유니크(uq_seat_watches_user_seat / _session_seat)는 유지한다 —
--    FK 가 아니라 중복 등록 차단·조회 성능용이며 v2 id 로도 그대로 유효하다.

DO $$
DECLARE
  con RECORD;
BEGIN
  IF to_regclass('public.seat_watches') IS NULL THEN
    RETURN; -- 테이블 없음(신규 환경) — 할 일 없음
  END IF;

  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.seat_watches'::regclass
       AND c.contype = 'f'
       AND a.attname = 'seat_id'
  LOOP
    EXECUTE format('ALTER TABLE seat_watches DROP CONSTRAINT IF EXISTS %I', con.conname);
  END LOOP;
END $$;

COMMENT ON COLUMN seat_watches.seat_id IS
  'v2 canonical seat_id (레벨2 T1). go seats FK 제거 — 좌석 정본은 v2, go 에 참조 대상이 없다.';
