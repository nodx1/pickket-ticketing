-- 206: 운영 복구 큐/cron 관측 원장
-- cron 실행 이력은 애플리케이션 메모리나 Redis가 아니라 DB에 남긴다.

CREATE TABLE IF NOT EXISTS ops_cron_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  result JSONB,
  error_summary TEXT,
  stale_reclaimed INTEGER NOT NULL DEFAULT 0,
  duplicate_claim_prevented INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT ck_ops_cron_runs_status CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT ck_ops_cron_runs_duration CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT ck_ops_cron_runs_counters CHECK (stale_reclaimed >= 0 AND duplicate_claim_prevented >= 0)
);

CREATE INDEX IF NOT EXISTS ix_ops_cron_runs_job_started
  ON ops_cron_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_ops_cron_runs_running
  ON ops_cron_runs(status, started_at)
  WHERE status = 'running';
