-- 연령 제한 CHECK 제약 완화 — 한국 공연예술 표준 + 직접 입력(custom) 대응
-- 기존: age_rating IN ('all', '12+', '15+', '18+')
-- 변경: TEXT 제약 해제 (프론트엔드/API에서 검증, DB는 자유 텍스트 허용)
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_age_rating_check;
