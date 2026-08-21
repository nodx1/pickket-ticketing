-- 내부 서비스 간 웹훅 감사 테이블
-- v2 ↔ go 전파 기록 (v2 webhook_deliveries와 별도, 충돌 회피)

CREATE TABLE IF NOT EXISTS inter_service_webhook_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  delivery_id   UUID NOT NULL,
  event         VARCHAR(100) NOT NULL,
  source        VARCHAR(20)  NOT NULL,
  direction     VARCHAR(10)  NOT NULL,
  signature     VARCHAR(128) NOT NULL,
  timestamp_sent  TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload       JSONB NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'received',
  error_message TEXT,
  retry_count   INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_isw_deliveries_delivery_direction UNIQUE (delivery_id, direction),
  CONSTRAINT ck_isw_deliveries_direction CHECK (direction IN ('inbound','outbound')),
  CONSTRAINT ck_isw_deliveries_status    CHECK (status IN ('received','processed','failed','duplicate','expired')),
  CONSTRAINT ck_isw_deliveries_source    CHECK (source IN ('portone','go','v2'))
);

CREATE INDEX IF NOT EXISTS ix_isw_deliveries_delivery_id ON inter_service_webhook_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS ix_isw_deliveries_event_received ON inter_service_webhook_deliveries(event, received_at DESC);
CREATE INDEX IF NOT EXISTS ix_isw_deliveries_source_status  ON inter_service_webhook_deliveries(source, status);
CREATE INDEX IF NOT EXISTS ix_isw_deliveries_received_at    ON inter_service_webhook_deliveries(received_at DESC);
