-- 레벨2 go DB 흡수 — 영역B: AI/지식 기능 폐기 (설계 §1 영역B).
--   go 자체 AI/지식 기능(에이전트·지식문서·공개 챗봇·SEO 생성 등)을 코드에서 완전 삭제하고,
--   그 데이터 테이블을 DROP 한다. v2 챗봇(chatbot_service)이 CS 챗봇을 대체하며, go 공개 챗봇은
--   v2 `/api/v1/chat` 로 라우팅된다. 실데이터 0건(부가기능) 전제 — 데이터 유실 우려 없음.
--
-- ⚠️ 커머스·좌석·메시징 무영향: AI 는 커머스에 단방향 의존(커머스→AI 역참조는 아래 1건뿐).
--   유일 역참조 = support_messages.agent_run_id (mig218, CS 트리아지 초안 연결). 라이브 SQL read 0건 →
--   컬럼째 제거 후 agent_runs DROP(FK 안전 순서).
--
-- ℹ️ 보존(폐기 대상 아님):
--   - events.seo_metadata(JSONB 컬럼, mig084) — v2 SEO write-through·소비자 상세가 의존(테이블 아님).
--     ⚠️ 원 계획서의 "seo_metadata" DROP 항목은 표준 컬럼과 혼동 — 이 컬럼은 커머스 의존이라 유지.
--   - event_inquiries.category / urgency(mig219) — 인입 문의 원장 부가 분류 컬럼. AI 가 채웠으나
--     passive 컬럼이라 유지(향후 수동 분류 재사용 가능). CHECK 제약 무해.
--
-- 가산적 규약 예외(파괴적 DROP)이나 IF EXISTS 로 방어 — 재실행 안전(idempotent).
-- 채번: 221 까지 점유 → 222 사용.

-- 1) 커머스→AI 유일 역참조 컬럼 제거(agent_runs DROP 전 FK 선해소).
ALTER TABLE IF EXISTS support_messages DROP COLUMN IF EXISTS agent_run_id;

-- 2) agent_runs 를 참조하는 AI 자식 테이블 먼저 DROP(FK 안전 순서).
DROP TABLE IF EXISTS ai_evaluations CASCADE;
DROP TABLE IF EXISTS agent_tasks CASCADE;

-- 3) 나머지 AI/지식 테이블 DROP.
DROP TABLE IF EXISTS agent_runs CASCADE;
DROP TABLE IF EXISTS ai_usage_logs CASCADE;
DROP TABLE IF EXISTS ai_usage CASCADE;
DROP TABLE IF EXISTS ai_content_cache CASCADE;
DROP TABLE IF EXISTS knowledge_documents CASCADE;
DROP TABLE IF EXISTS event_context_snapshots CASCADE;
DROP TABLE IF EXISTS public_chat_sessions CASCADE;

-- 4) accounts 의 AI 쿼터 컬럼 제거(mig102).
ALTER TABLE IF EXISTS accounts DROP COLUMN IF EXISTS ai_quota;

-- 참고: 원 계획서의 'ai_quotas' 테이블은 실재하지 않음(실제는 ai_usage 테이블 + accounts.ai_quota 컬럼,
--   mig102). 위 3)·4) 로 커버된다.
