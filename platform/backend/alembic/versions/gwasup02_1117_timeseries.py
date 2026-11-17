"""TimescaleDB 시계열 로그 (과업 WP5)

🔴 왜
   과업지시서: "TimescaleDB 시계열 로그를 구축한다", 현장 입장·부정 탐지 실시간 모니터링.

무엇을 만드나 (추가만)
   ts_lottery_events     응모·수정·마감·추첨·제재 시계열           ┐
   ts_admission_events   현장 입장 판정·부정 탐지 시계열(단말·게이트) ├ append-only
   ts_weight_snapshots   누적 시간 점수 배치 결과                   ┘
   ts_admission_1m       입장 1분 집계 (TimescaleDB 연속 집계 / 없으면 일반 뷰)
   ts_lottery_1m         응모 1분 집계

✅ 운영 DB 가 일반 PostgreSQL 이어도 실패하지 않는다:
   - timescaledb 확장이 설치 가능하면 hypertable + 연속 집계
   - 아니면 일반 테이블 + BRIN 시간 인덱스 + date_trunc 뷰
   어느 쪽이 적용됐는지는 ts_storage_mode() 함수로 조회한다.

Revision ID: gwasup02_1117
Revises: gwasup01_1117
Create Date: 2026-11-17
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "gwasup02_1117"
down_revision = "gwasup01_1117"
branch_labels = None
depends_on = None

TABLES = ("ts_lottery_events", "ts_admission_events", "ts_weight_snapshots")


def _timescale_available(bind) -> bool:
    row = bind.execute(
        sa.text("SELECT installed_version, default_version FROM pg_available_extensions WHERE name = 'timescaledb'")
    ).first()
    if row is None:
        return False
    if row[0]:
        return True
    try:
        with bind.begin_nested():
            bind.execute(sa.text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
        return True
    except Exception:  # noqa: BLE001 — 권한 없음 등: 일반 테이블로 내려간다
        return False


def upgrade() -> None:
    bind = op.get_bind()
    op.execute(
        """
        CREATE TABLE ts_lottery_events (
            time        TIMESTAMPTZ NOT NULL DEFAULT now(),
            event_id    UUID NOT NULL,
            pool_id     UUID,
            tier_id     UUID,
            kind        TEXT NOT NULL,
            user_commit TEXT,
            weight      DOUBLE PRECISION,
            ap          INTEGER,
            meta        JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE TABLE ts_admission_events (
            time        TIMESTAMPTZ NOT NULL DEFAULT now(),
            event_id    UUID NOT NULL,
            terminal_id UUID,
            gate        TEXT,
            ticket_ref  TEXT,
            result      TEXT NOT NULL,
            reason      TEXT,
            meta        JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE TABLE ts_weight_snapshots (
            time          TIMESTAMPTZ NOT NULL DEFAULT now(),
            user_id       UUID NOT NULL,
            tenure_score  DOUBLE PRECISION NOT NULL,
            account_days  INTEGER,
            admissions    INTEGER,
            meta          JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        """
    )

    timescale = _timescale_available(bind)
    if timescale:
        for table in TABLES:
            op.execute(
                f"SELECT create_hypertable('{table}', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE)"
            )
    else:
        for table in TABLES:
            op.execute(f"CREATE INDEX idx_{table}_time_brin ON {table} USING BRIN (time)")

    op.execute("CREATE INDEX idx_ts_lottery_event_time ON ts_lottery_events (event_id, time DESC)")
    op.execute("CREATE INDEX idx_ts_admission_event_time ON ts_admission_events (event_id, time DESC)")
    op.execute("CREATE INDEX idx_ts_weight_user_time ON ts_weight_snapshots (user_id, time DESC)")

    # append-only (gwasup01 의 함수 재사용). hypertable 은 행 트리거를 청크로 전파한다.
    for table in TABLES:
        op.execute(
            f"""
            CREATE TRIGGER trg_{table}_no_update BEFORE UPDATE ON {table}
                FOR EACH ROW EXECUTE FUNCTION trg_gwasup_append_only();
            CREATE TRIGGER trg_{table}_no_delete BEFORE DELETE ON {table}
                FOR EACH ROW EXECUTE FUNCTION trg_gwasup_append_only();
            """
        )

    mode = "timescaledb" if timescale else "postgresql"
    op.execute(
        f"CREATE OR REPLACE FUNCTION ts_storage_mode() RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT '{mode}'::text $$"
    )

    if timescale:
        # 연속 집계는 트랜잭션 밖에서 만들어야 한다
        with op.get_context().autocommit_block():
            op.execute(
                """
                CREATE MATERIALIZED VIEW IF NOT EXISTS ts_admission_1m
                WITH (timescaledb.continuous) AS
                SELECT time_bucket(INTERVAL '1 minute', time) AS bucket,
                       event_id, gate, result, count(*) AS n
                FROM ts_admission_events
                GROUP BY bucket, event_id, gate, result
                WITH NO DATA
                """
            )
            op.execute(
                """
                CREATE MATERIALIZED VIEW IF NOT EXISTS ts_lottery_1m
                WITH (timescaledb.continuous) AS
                SELECT time_bucket(INTERVAL '1 minute', time) AS bucket,
                       event_id, kind, count(*) AS n, sum(coalesce(ap, 0)) AS ap_sum
                FROM ts_lottery_events
                GROUP BY bucket, event_id, kind
                WITH NO DATA
                """
            )
            op.execute(
                "SELECT add_continuous_aggregate_policy('ts_admission_1m', start_offset => INTERVAL '1 day', "
                "end_offset => NULL, schedule_interval => INTERVAL '30 seconds', if_not_exists => TRUE)"
            )
            op.execute(
                "SELECT add_continuous_aggregate_policy('ts_lottery_1m', start_offset => INTERVAL '7 days', "
                "end_offset => NULL, schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE)"
            )
            # 실시간 집계: 아직 물질화되지 않은 최근 구간도 조회에 포함
            op.execute("ALTER MATERIALIZED VIEW ts_admission_1m SET (timescaledb.materialized_only = false)")
            op.execute("ALTER MATERIALIZED VIEW ts_lottery_1m SET (timescaledb.materialized_only = false)")
    else:
        op.execute(
            """
            CREATE VIEW ts_admission_1m AS
            SELECT date_trunc('minute', time) AS bucket, event_id, gate, result, count(*) AS n
            FROM ts_admission_events GROUP BY 1, 2, 3, 4;
            CREATE VIEW ts_lottery_1m AS
            SELECT date_trunc('minute', time) AS bucket, event_id, kind, count(*) AS n, sum(coalesce(ap, 0)) AS ap_sum
            FROM ts_lottery_events GROUP BY 1, 2, 3;
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    mode = bind.execute(sa.text("SELECT ts_storage_mode()")).scalar()
    if mode == "timescaledb":
        with op.get_context().autocommit_block():
            op.execute("DROP MATERIALIZED VIEW IF EXISTS ts_admission_1m CASCADE")
            op.execute("DROP MATERIALIZED VIEW IF EXISTS ts_lottery_1m CASCADE")
    else:
        op.execute("DROP VIEW IF EXISTS ts_admission_1m")
        op.execute("DROP VIEW IF EXISTS ts_lottery_1m")
    for table in TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    op.execute("DROP FUNCTION IF EXISTS ts_storage_mode()")
