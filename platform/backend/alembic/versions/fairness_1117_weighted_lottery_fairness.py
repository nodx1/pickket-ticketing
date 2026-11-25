"""가중치 추첨 정책 · Merkle 무결성 · 공정성 증명서 (과업 WP1·WP4)

🔴 왜
   과업지시서: "가중치 추첨 데이터 설계", "Merkle 트리 기반으로 추첨 결과의 무결성을 보장하는
   데이터 모델", "Merkle 트리 기반 공정성 증명서 발행·조회".

무엇을 만드나 (전부 **추가**만 한다 — 기존 테이블·컬럼은 건드리지 않는다)
   lottery_weight_policies   주최사 가중치 정책(수정 가능, 변경은 audit_logs 에 기록)
   lottery_pool_policies     풀 사전 커밋 시점 정책 스냅숏      ┐
   lottery_merkle_leaves     응모/결과 트리 잎                  ├ append-only
   lottery_merkle_roots      응모/결과 트리 루트                │ (UPDATE·DELETE·TRUNCATE 거부)
   fairness_certificates     Ed25519 서명 공정성 증명서         ┘
   fairness_certificate_seq  발급번호 시퀀스

✅ 운영 영향 없음: 새 테이블은 새 기능만 쓴다. 정책이 없는 풀은 기존 상수(기본 정책)로 동작한다.

Revision ID: fairness_1117
Revises: inv50_0809
Create Date: 2026-11-17
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "fairness_1117"
down_revision = "inv50_0809"
branch_labels = None
depends_on = None

APPEND_ONLY_TABLES = (
    "lottery_pool_policies",
    "lottery_merkle_leaves",
    "lottery_merkle_roots",
    "fairness_certificates",
)


def upgrade() -> None:
    op.create_table(
        "lottery_weight_policies",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tier_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("seat_tiers.id", ondelete="CASCADE"), nullable=True),
        sa.Column("preset", sa.String(32), nullable=False, server_default="custom"),
        sa.Column("policy", postgresql.JSONB(), nullable=False),
        sa.Column("policy_hash", sa.String(64), nullable=False),
        sa.Column("updated_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("idx_lwp_event", "lottery_weight_policies", ["event_id"])
    # (event_id, tier_id) 당 하나 — tier_id NULL(이벤트 공통)도 하나만 허용
    op.execute(
        "CREATE UNIQUE INDEX uq_lwp_event_tier ON lottery_weight_policies "
        "(event_id, COALESCE(tier_id, '00000000-0000-0000-0000-000000000000'::uuid))"
    )

    op.create_table(
        "lottery_pool_policies",
        sa.Column("pool_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("lottery_pools.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("policy", postgresql.JSONB(), nullable=False),
        sa.Column("policy_hash", sa.String(64), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("locked_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "lottery_merkle_leaves",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("pool_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("lottery_pools.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("idx", sa.Integer(), nullable=False),
        sa.Column("leaf_hash", sa.String(64), nullable=False),
        sa.Column("entry_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("salt", sa.String(32), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("pool_id", "kind", "idx", name="uq_merkle_leaf_pos"),
        sa.CheckConstraint("kind IN ('entries','results')", name="ck_merkle_leaf_kind"),
    )
    op.create_index("idx_merkle_leaf_pool_user", "lottery_merkle_leaves", ["pool_id", "user_id"])

    op.create_table(
        "lottery_merkle_roots",
        sa.Column("pool_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("lottery_pools.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("kind", sa.String(16), primary_key=True),
        sa.Column("root", sa.String(64), nullable=False),
        sa.Column("leaf_count", sa.Integer(), nullable=False),
        sa.Column("tree_algorithm", sa.String(64), nullable=False),
        sa.Column("built_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('entries','results')", name="ck_merkle_root_kind"),
    )

    op.execute("CREATE SEQUENCE IF NOT EXISTS fairness_certificate_seq START 1")
    op.create_table(
        "fairness_certificates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("cert_no", sa.String(32), nullable=False, unique=True),
        sa.Column("pool_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("lottery_pools.id", ondelete="RESTRICT"), nullable=False, unique=True),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("signature", sa.String(128), nullable=False),
        sa.Column("key_id", sa.String(32), nullable=False),
        sa.Column("signature_algorithm", sa.String(16), nullable=False, server_default="Ed25519"),
        sa.Column("issued_by", sa.String(64), nullable=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("idx_fairness_cert_event", "fairness_certificates", ["event_id"])

    # ── append-only 강제 ──
    op.execute(
        """
        CREATE OR REPLACE FUNCTION trg_append_only()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION '% is append-only: % not allowed', TG_TABLE_NAME, TG_OP;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    for table in APPEND_ONLY_TABLES:
        op.execute(
            f"""
            CREATE TRIGGER trg_{table}_no_update BEFORE UPDATE ON {table}
                FOR EACH ROW EXECUTE FUNCTION trg_append_only();
            CREATE TRIGGER trg_{table}_no_delete BEFORE DELETE ON {table}
                FOR EACH ROW EXECUTE FUNCTION trg_append_only();
            CREATE TRIGGER trg_{table}_no_truncate BEFORE TRUNCATE ON {table}
                FOR EACH STATEMENT EXECUTE FUNCTION trg_append_only();
            """
        )


def downgrade() -> None:
    for table in reversed(APPEND_ONLY_TABLES):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    op.execute("DROP SEQUENCE IF EXISTS fairness_certificate_seq")
    op.execute("DROP TABLE IF EXISTS lottery_weight_policies CASCADE")
    op.execute("DROP FUNCTION IF EXISTS trg_append_only()")
