-- 158: schema_migrations에 체크섬 추가 (H3 대응)
-- 이미 적용된 마이그레이션 파일이 사후 편집됐는지 SHA256 체크섬으로 감지.
-- scripts/migrate.ts가 기존 checksum과 파일 checksum을 대조, 불일치 시 abort.
--
-- 이 마이그레이션 자체는 기존 행의 checksum을 NULL로 남겨둠. scripts/migrate.ts가
-- 최초 실행 시 backfill 한다 (NULL만 채우고 기존 값은 보존).

ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS checksum TEXT;
