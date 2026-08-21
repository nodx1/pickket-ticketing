-- §13 오프라인/열화 체크인 모드: check_in_logs.method 에 'offline' 추가.
-- 오프라인(LTE 끊김) 상황에서 로컬 큐에 기록된 체크인은 온라인 복귀 시 서버로 배치 전송되며,
-- 회전 QR 을 서버검증하지 못한 채 스태프 육안 대조로 확인된 입장이므로 'qr'/'manual' 과 구분해
-- method='offline' 로 기록한다(집계·감사에서 오프라인 유래를 식별하기 위함).
--
-- 가산적 하위호환: 기존 값('qr','manual','search')은 그대로 허용, 온라인 정상 경로 동작 불변.
ALTER TABLE check_in_logs DROP CONSTRAINT IF EXISTS check_in_logs_method_check;

ALTER TABLE check_in_logs
  ADD CONSTRAINT check_in_logs_method_check
  CHECK (method IN ('qr', 'manual', 'search', 'offline'));
