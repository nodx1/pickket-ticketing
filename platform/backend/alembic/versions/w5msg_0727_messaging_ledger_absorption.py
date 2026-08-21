"""레벨2 컷오버 W5-MSG — 발송 원장 계열 go 흡수 마무리.

W3-MSG 가 억제/동의 원장을, orgmsg_0724 가 메시지/발송/시도 골격을 이미 옮겼다.
이 리비전은 **남은 발송 원장 본체**를 v2 로 마저 가져온다:

  · go 094/183/190/199/200 email_campaigns / email_campaign_recipients  → 신설
  · go 098/208             inbound_emails                                → 신설
  · go 207                 message_delivery_attempts.provider_lookup_*   → 컬럼 가산

⚠️ 캠페인은 **폐기하지 않는다**(대표 결정 2026-07-27). go 220 이 캠페인 발송 경로를
   event_messages 로 수렴시켰지만 캠페인 원본(초안·세그먼트·수신자 스냅샷·오픈/클릭)은
   주최자 화면에서 계속 조회된다 — 정체성을 보존한 채 원장만 옮긴다.

🔴 inbound_emails 테넌트 경계: go 원본에는 account_id 가 없어 event 소유검증이 유일한
   경계였다. 여기서 account_id 를 가산하되 **NULL 허용**(매칭 실패한 수신 메일 보존).
   조회는 event_id 일치 + (account_id 가 있으면 일치)를 요구 — 옛 계약과 동등하거나 강함.

전부 가산·비파괴·재실행 안전(존재가드). 실데이터 0 전제(go 원본은 250 에서 DROP).
부분/표현식 인덱스는 모델 선언으로 표현 불가하므로 여기서 원문 DDL 로 재현한다.

Revision ID: w5msg_0727
Revises: w2_mrg_0727
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "w5msg_0727"
down_revision = "w2_mrg_0727"
branch_labels = None
depends_on = None


UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB
TS = sa.DateTime(timezone=True)


def _cols(insp, table: str) -> set[str]:
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    is_pg = bind.dialect.name == "postgresql"

    # ── 1) message_delivery_attempts: provider 대사 증적 컬럼 (go 207) ────────
    #    "조회했는데 수신자를 못 찾음"과 "조회 자체를 못 함"을 구분하지 못하면
    #    manual_review 승격 판정의 근거가 사라진다.
    if insp.has_table("message_delivery_attempts"):
        existing = _cols(insp, "message_delivery_attempts")
        if "provider_lookup_count" not in existing:
            op.add_column(
                "message_delivery_attempts",
                sa.Column(
                    "provider_lookup_count",
                    sa.Integer(),
                    nullable=False,
                    server_default=sa.text("0"),
                ),
            )
        if "provider_last_lookup_at" not in existing:
            op.add_column(
                "message_delivery_attempts",
                sa.Column("provider_last_lookup_at", TS, nullable=True),
            )
        if "provider_last_lookup_status" not in existing:
            op.add_column(
                "message_delivery_attempts",
                sa.Column("provider_last_lookup_status", sa.Text(), nullable=True),
            )

    # ── 2) email_campaigns (go 094/183/199) ─────────────────────────────────
    if not insp.has_table("email_campaigns"):
        op.create_table(
            "email_campaigns",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("event_id", UUID, nullable=False),
            sa.Column("subject", sa.Text(), nullable=False),
            sa.Column("body_html", sa.Text(), nullable=False),
            sa.Column("body_text", sa.Text(), nullable=True),
            sa.Column("segment", JSONB, nullable=True),
            sa.Column(
                "status", sa.String(length=30), nullable=False, server_default="draft"
            ),
            sa.Column(
                "message_type",
                sa.String(length=20),
                nullable=False,
                server_default="advertising",
            ),
            sa.Column("scheduled_at", TS, nullable=True),
            sa.Column("sent_at", TS, nullable=True),
            sa.Column("stats", JSONB, nullable=True),
            sa.Column("claim_token", UUID, nullable=True),
            sa.Column("claim_expires_at", TS, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "status IN ('draft','scheduled','sending','sent','sent_with_failures',"
                "'failed','cancelled')",
                name="ck_email_campaigns_status",
            ),
            sa.CheckConstraint(
                "message_type IN ('informational','advertising')",
                name="ck_email_campaigns_message_type",
            ),
        )
        op.create_index("idx_email_campaigns_account", "email_campaigns", ["account_id"])
        op.create_index("idx_email_campaigns_event", "email_campaigns", ["event_id"])
        op.create_index("idx_email_campaigns_status", "email_campaigns", ["status"])

    # go 199 실행 소유권 lease 부분 인덱스 재현(진행 중 캠페인만 색인 — 인덱스 비대 방지).
    # ⚠️ 여기서 `insp`(리비전 진입 시점 스냅샷)로 존재검사를 하면 **방금 만든 테이블을 못 본다**.
    #    IF NOT EXISTS 가 이미 멱등을 보장하므로 존재검사 없이 그대로 실행한다.
    if is_pg:
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_email_campaigns_claim_lease "
            "ON email_campaigns(status, claim_expires_at) WHERE status = 'sending'"
        )

    # ── 3) email_campaign_recipients (go 094/190/200) ───────────────────────
    if not insp.has_table("email_campaign_recipients"):
        op.create_table(
            "email_campaign_recipients",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("campaign_id", UUID, nullable=False),
            sa.Column("email", sa.Text(), nullable=False),
            sa.Column("name", sa.Text(), nullable=True),
            sa.Column(
                "status", sa.String(length=20), nullable=False, server_default="pending"
            ),
            sa.Column("sent_at", TS, nullable=True),
            sa.Column("opened_at", TS, nullable=True),
            sa.Column("clicked_at", TS, nullable=True),
            sa.Column("claim_token", UUID, nullable=True),
            sa.Column("claim_expires_at", TS, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "status IN ('pending','sending','sent','delivered','failed','skipped','unknown')",
                name="ck_email_campaign_recipients_status",
            ),
            sa.ForeignKeyConstraint(
                ["campaign_id"], ["email_campaigns.id"], ondelete="CASCADE"
            ),
            sa.UniqueConstraint("campaign_id", "email", name="uq_email_campaign_recipient"),
        )
        op.create_index(
            "idx_ecr_campaign", "email_campaign_recipients", ["campaign_id"]
        )
        op.create_index("idx_ecr_email", "email_campaign_recipients", ["email"])

    if is_pg:
        # go 190 = lower(email) 유니크. 대소문자만 다른 같은 주소로 2회 발송되는 것을 막는
        # 실질 계약이므로 표현식 유니크로 재현한다(모델의 (campaign_id,email) 유니크보다 강함).
        op.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_ecr_campaign_email_lower "
            "ON email_campaign_recipients(campaign_id, lower(email))"
        )
        # go 200 수신자 lease 부분 인덱스.
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_email_campaign_recipients_claim_lease "
            "ON email_campaign_recipients(campaign_id, status, claim_expires_at) "
            "WHERE status = 'sending'"
        )

    # ── 4) inbound_emails (go 098/208) ──────────────────────────────────────
    if not insp.has_table("inbound_emails"):
        op.create_table(
            "inbound_emails",
            sa.Column("id", UUID, primary_key=True),
            # NULL 허용 = 어떤 이벤트/계정으로도 매칭 못 한 수신 메일(go 원본 동작 보존).
            sa.Column("account_id", UUID, nullable=True),
            sa.Column("event_id", UUID, nullable=True),
            sa.Column("from_email", sa.Text(), nullable=False),
            sa.Column("from_name", sa.Text(), nullable=True),
            sa.Column("subject", sa.Text(), nullable=True),
            sa.Column("body_text", sa.Text(), nullable=True),
            sa.Column("body_html", sa.Text(), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="new"),
            sa.Column("assigned_to", UUID, nullable=True),
            sa.Column("ai_draft", sa.Text(), nullable=True),
            sa.Column("reply_body", sa.Text(), nullable=True),
            sa.Column("replied_at", TS, nullable=True),
            sa.Column("replied_by", UUID, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "status IN ('new','replied','archived')", name="ck_inbound_emails_status"
            ),
        )
        op.create_index("idx_inbound_emails_event", "inbound_emails", ["event_id"])
        op.create_index("idx_inbound_emails_status", "inbound_emails", ["status"])
        op.create_index("idx_inbound_emails_account", "inbound_emails", ["account_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if insp.has_table("inbound_emails"):
        op.drop_table("inbound_emails")
    if insp.has_table("email_campaign_recipients"):
        op.drop_table("email_campaign_recipients")
    if insp.has_table("email_campaigns"):
        op.drop_table("email_campaigns")
    if insp.has_table("message_delivery_attempts"):
        existing = _cols(insp, "message_delivery_attempts")
        for col in (
            "provider_last_lookup_status",
            "provider_last_lookup_at",
            "provider_lookup_count",
        ):
            if col in existing:
                op.drop_column("message_delivery_attempts", col)
