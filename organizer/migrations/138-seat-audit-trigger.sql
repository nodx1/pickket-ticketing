-- Phase 1-5: seats 동작 audit_logs 자동 기록
-- v2 audit 시스템 미러
-- 모든 seat 상태 변경 (status, hold_id) → audit_logs INSERT

CREATE OR REPLACE FUNCTION log_seat_change()
RETURNS TRIGGER AS $$
BEGIN
  -- 상태 변경만 기록 (단순 timestamp 갱신은 무시)
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO audit_logs (
      id, account_id, action, table_name, record_id, changes, created_at
    ) VALUES (
      gen_random_uuid(), NEW.account_id, 'create', 'seats', NEW.id,
      jsonb_build_object(
        'eventId', (SELECT event_id::text FROM seat_maps WHERE id = NEW.seat_map_id),
        'status', NEW.status,
        'tier_id', NEW.tier_id::text
      ),
      NOW()
    );
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE' AND (
    OLD.status IS DISTINCT FROM NEW.status OR
    OLD.hold_id IS DISTINCT FROM NEW.hold_id OR
    OLD.reserved_order_id IS DISTINCT FROM NEW.reserved_order_id
  )) THEN
    INSERT INTO audit_logs (
      id, account_id, action, table_name, record_id, changes, created_at
    ) VALUES (
      gen_random_uuid(), NEW.account_id, 'update', 'seats', NEW.id,
      jsonb_build_object(
        'eventId', (SELECT event_id::text FROM seat_maps WHERE id = NEW.seat_map_id),
        'old_status', OLD.status,
        'new_status', NEW.status,
        'hold_id', NEW.hold_id::text,
        'order_id', NEW.reserved_order_id::text
      ),
      NOW()
    );
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_log_seat_change ON seats;
CREATE TRIGGER trg_log_seat_change
  AFTER INSERT OR UPDATE ON seats
  FOR EACH ROW
  EXECUTE FUNCTION log_seat_change();

COMMENT ON FUNCTION log_seat_change() IS '좌석 상태 변경 자동 audit. v2 호환 카테고리 14.';
