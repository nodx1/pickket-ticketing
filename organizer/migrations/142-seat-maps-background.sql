-- 트랙 2.1 — 좌석맵에 도면 이미지 배경 추가
--
-- 빌더에서 PNG/JPG/SVG 도면을 업로드해 좌석 레이어 아래에 깔 수 있게 한다.
-- - background_url: S3 또는 픽킷 자체 호스팅 URL
-- - background_opacity: 0~1 (사이드 슬라이더로 조절)
-- - background_width/height: 원본 픽셀 크기 (좌표 매칭용)

ALTER TABLE seat_maps
  ADD COLUMN IF NOT EXISTS background_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS background_opacity NUMERIC(3,2) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS background_width INT NULL,
  ADD COLUMN IF NOT EXISTS background_height INT NULL;

ALTER TABLE seat_maps
  ADD CONSTRAINT seat_maps_background_opacity_range
  CHECK (background_opacity >= 0 AND background_opacity <= 1);

COMMENT ON COLUMN seat_maps.background_url IS
  '좌석맵 배경 도면 이미지 URL (S3 권장). 없으면 빈 캔버스.';
COMMENT ON COLUMN seat_maps.background_opacity IS
  '배경 투명도 0~1. 빌더 슬라이더로 조절.';
