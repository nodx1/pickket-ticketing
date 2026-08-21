-- 이벤트 이미지 렌디션 맵 (P1) — 업로드 시 서버가 생성한 화면비별 URL.
-- {wide, portrait, thumb, og} (마스터는 hero_image_url). 기존 이벤트는 {} → 폴백(hero_image_url) 사용.
ALTER TABLE events ADD COLUMN IF NOT EXISTS image_variants JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN events.image_variants IS '화면비별 렌디션 URL 맵: {wide,portrait,thumb,og}. 마스터=hero_image_url';
