-- 157: 성능 복합 인덱스 추가 (Opus 4.7 전수 감사 H7 대응)
-- orders/attendees 테이블의 핵심 WHERE 조합이 단독 인덱스에만 의존 → 대시보드/리포트에서
-- bitmap AND 또는 sequential scan 발생. 복합 인덱스로 커버링 스캔 전환.
--
-- ⚠️ 기존 idx_orders_event_id / idx_orders_account_id 등 단독 인덱스는 유지 —
-- 단일 컬럼 필터 쿼리에 여전히 사용됨. 복합은 WHERE 3컬럼 이상 결합 케이스 전용.

-- 주문 리스트/대시보드: account_id + event_id + status 조합 WHERE
CREATE INDEX IF NOT EXISTS idx_orders_account_event_status
  ON orders(account_id, event_id, status);

-- 일일 매출 그래프: event_id + 정렬 정렬
CREATE INDEX IF NOT EXISTS idx_orders_event_ordered_at
  ON orders(event_id, ordered_at DESC)
  WHERE ordered_at IS NOT NULL;

-- 참석자 상태별 필터 + 체크인 정렬
CREATE INDEX IF NOT EXISTS idx_attendees_event_status
  ON attendees(event_id, status)
  WHERE status != 'cancelled';

CREATE INDEX IF NOT EXISTS idx_attendees_event_checked_in
  ON attendees(event_id, checked_in_at DESC)
  WHERE checked_in_at IS NOT NULL;

-- audit_logs(account_id, created_at DESC)는 139-audit-logs-partitioning.sql에서 이미 생성됨.
-- 시스템 전역 감사 로그 정렬은 account별 스캔 후 병합이 충분하므로 추가 인덱스 불필요.
