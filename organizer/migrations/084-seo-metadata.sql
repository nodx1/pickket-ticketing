ALTER TABLE events
ADD COLUMN IF NOT EXISTS seo_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN events.seo_metadata IS 'AI 생성 SEO 메타데이터 (title, description, keywords, ogTitle, ogDescription)';
