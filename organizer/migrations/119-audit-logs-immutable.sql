-- Phase 5C-5: audit_logs DB 레벨 immutability
--
-- 목적: 감사 로그를 DB 트리거로 append-only 강제.
-- 애플리케이션 코드가 실수로 UPDATE/DELETE/TRUNCATE 해도 트리거가 예외 발생.
--
-- 선결 확인 (2026-04-05 grep):
--   src/ 전체에 "UPDATE audit_logs", "DELETE FROM audit_logs", "TRUNCATE ... audit_logs" 없음.
--   src/lib/audit.ts는 INSERT만 사용.
--
-- 롤백이 필요하면:
--   DROP TRIGGER audit_logs_no_update ON audit_logs;
--   DROP TRIGGER audit_logs_no_delete ON audit_logs;
--   DROP TRIGGER audit_logs_no_truncate ON audit_logs;
--   DROP FUNCTION prevent_audit_log_mutation();

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only. Operation % denied by immutability trigger.', TG_OP
    USING HINT = '감사 로그는 DB 레벨에서 수정/삭제가 차단됩니다. INSERT만 가능합니다.';
END;
$$ LANGUAGE plpgsql;

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

COMMENT ON FUNCTION prevent_audit_log_mutation() IS
  'audit_logs append-only 강제. Phase 5C-5 (2026-04-05) 도입.';
