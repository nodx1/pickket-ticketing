-- P0-AU1: audit_logs 월별 파티셔닝 (대량 쓰기 대응)
--
-- 기존 audit_logs 테이블을 RANGE BY created_at 으로 파티셔닝한다.
-- 주의사항:
-- 1) 기존 PK(id UUID)는 파티션 컬럼을 포함해야 하므로 (id, created_at) 복합 PK로 변경.
-- 2) 119에서 생성한 immutable 트리거는 DROP CASCADE로 사라지므로 재생성.
-- 3) 기존 데이터는 audit_logs_legacy 백업 테이블에 보존 후 복원.
-- 4) 월별 파티션 자동 생성이 필요하면 추후 pg_partman 또는 cron 연동.

-- 1. 기존 테이블 백업
CREATE TABLE IF NOT EXISTS audit_logs_legacy AS TABLE audit_logs;

-- 2. 기존 테이블 삭제 (immutable 트리거는 DDL이므로 차단되지 않음)
DROP TABLE IF EXISTS audit_logs CASCADE;

-- 3. 새 partitioned 테이블 (RANGE BY created_at)
CREATE TABLE audit_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  account_id UUID,
  user_id UUID,
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id UUID,
  changes JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 4. 인덱스
CREATE INDEX IF NOT EXISTS idx_audit_logs_account_created
  ON audit_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record
  ON audit_logs(table_name, record_id);

-- 5. 현재 + 다음 3개월 파티션 생성
DO $$
DECLARE
  start_date DATE := date_trunc('month', NOW())::DATE;
  i INT;
  part_start DATE;
  part_end DATE;
  part_name TEXT;
BEGIN
  FOR i IN 0..3 LOOP
    part_start := start_date + (i || ' months')::INTERVAL;
    part_end := start_date + ((i + 1) || ' months')::INTERVAL;
    part_name := format('audit_logs_y%sm%s',
      to_char(part_start, 'YYYY'),
      to_char(part_start, 'MM'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, part_end
    );
  END LOOP;
END $$;

-- 6. 파티션 범위 밖의 과거 데이터를 받기 위한 default 파티션
CREATE TABLE IF NOT EXISTS audit_logs_default PARTITION OF audit_logs DEFAULT;

-- 7. 기존 데이터 복원
INSERT INTO audit_logs (
  id, account_id, user_id, action, table_name, record_id,
  changes, ip_address, created_at, updated_at
)
SELECT
  id, account_id, user_id, action, table_name, record_id,
  changes, ip_address, created_at, updated_at
FROM audit_logs_legacy;

-- 8. 119 immutable 트리거 재적용 (DROP CASCADE로 사라졌음)
DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_mutation();

-- legacy 테이블은 백업으로 보존. 검증 후 수동 DROP.
COMMENT ON TABLE audit_logs_legacy IS
  '139 마이그레이션 백업. 파티션 정합성 검증 후 수동 DROP 하세요.';
COMMENT ON TABLE audit_logs IS
  'P0-AU1: 월별 파티셔닝. 매월 새 파티션 자동 생성 cron/pg_partman 필요.';
