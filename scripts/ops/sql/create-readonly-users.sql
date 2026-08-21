-- 운영 진단용 읽기전용 DB 유저 생성 (가드레일 #2: 에이전트는 이 유저만 사용 → 쓰기 권한 자체가 없음)
-- 실행: 대표가 X99 각 DB 컨테이너에서 (routine-마이그레이션.md 의 접속 방법 참조)
--   docker exec -it <pickket-go-db|pickket-db 컨테이너> psql -U <admin유저> -d <db>
-- ⚠️ 비밀번호는 실행 전 강한 값으로 교체하고, 성공 후 ~/Desktop/pickket-caprover-secrets.env 에 기록.

-- ── go DB (pickket-go-db) ──
CREATE ROLE ops_readonly WITH LOGIN PASSWORD 'CHANGE_ME_STRONG';
GRANT CONNECT ON DATABASE CURRENT_DATABASE TO ops_readonly;  -- psql 변수 안 먹으면 DB명 직접 기입
GRANT USAGE ON SCHEMA public TO ops_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ops_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ops_readonly;
-- 명시적 쓰기 차단(이중 안전):
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ops_readonly;

-- ── v2 DB (pickket-db) 에도 동일하게 반복 ──

-- 검증:
--   \c - ops_readonly
--   SELECT COUNT(*) FROM event_messages;          -- 성공해야 함
--   INSERT INTO event_messages DEFAULT VALUES;    -- "permission denied" 여야 함

-- 적용 후: sentinel.sh 의 발송큐 체크 주석 해제 + GO_DB_RO_URL 을 ops.env 에 설정
--   GO_DB_RO_URL=postgresql://ops_readonly:<pw>@192.168.0.9:<포트>/<db>
--   (X99 pg 포트가 외부 노출 안 돼 있으면 ssh 터널 또는 CapRover 포트매핑 필요 — W2 에서 결정)
