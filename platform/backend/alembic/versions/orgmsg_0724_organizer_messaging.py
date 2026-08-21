"""레벨2 영역C — 조직자 메시징 서브시스템 스키마 (go 흡수, 1차 골격).

go(pickket.go) 의 조직자용 메시징/알림/발송/동의/억제/리마인더/웹훅 테이블을 v2 로 흡수한다.
go 마이그레이션 032/053/073/146/181~201/220 을 v2 단일 리비전으로 수렴(220 수렴형 —
email_campaigns 는 만들지 않고 event_messages 로 통일).

전부 가산·비파괴·재실행 안전(IF NOT EXISTS / 존재가드). 실데이터 0 전제.

부분 인덱스(claim-lease WHERE status='sending'·reconcile·opened/clicked·dispatch)와
suppression COALESCE 전역 유니크는 **모델 선언으로는 표현 불가**하므로 이 리비전에서
op.create_index(postgresql_where=) / op.execute 원문 DDL 로 재현한다.

⚠️ 조직자용 organizer_notifications 는 v2 팬용 notifications(user 스코프)와 별개 테이블.
⚠️ organizer_webhooks 는 v2 inter_service_webhook_deliveries 와 이름 충돌 회피(prefix).

Revision ID: orgmsg_0724
Revises: unify8_0723
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "orgmsg_0724"
down_revision = "unify8_0723"
branch_labels = None
depends_on = None


UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB
TS = sa.DateTime(timezone=True)


def _has_table(insp, name: str) -> bool:
    return insp.has_table(name)


def _idx(insp, table: str) -> set[str]:
    return {i["name"] for i in insp.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # ── 1) organizer_notifications (go 073/146) ──────────────────────────────
    if not _has_table(insp, "organizer_notifications"):
        op.create_table(
            "organizer_notifications",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("event_id", UUID, nullable=True),
            sa.Column("type", sa.String(length=40), nullable=False),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("message", sa.Text(), nullable=False),
            sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("metadata", JSONB, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "type IN ('refund_request','sold_out','payment_failed','new_order',"
                "'check_in_milestone','system')",
                name="ck_organizer_notifications_type",
            ),
        )
        op.create_index(
            "idx_organizer_notifications_account", "organizer_notifications", ["account_id"]
        )
        op.create_index(
            "idx_organizer_notifications_account_read",
            "organizer_notifications",
            ["account_id", "is_read"],
        )

    # ── 2) event_messages (go 032/183/185~188/192/199/201, 220 수렴형) ───────
    if not _has_table(insp, "event_messages"):
        op.create_table(
            "event_messages",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("event_id", UUID, nullable=False),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("channel", sa.String(length=20), nullable=False),
            sa.Column(
                "message_type",
                sa.String(length=20),
                nullable=False,
                server_default=sa.text("'informational'"),
            ),
            sa.Column(
                "status", sa.String(length=30), nullable=False, server_default=sa.text("'draft'")
            ),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column(
                "recipient_filter",
                sa.String(length=40),
                nullable=False,
                server_default=sa.text("'all'"),
            ),
            sa.Column("segment", JSONB, nullable=True),
            sa.Column("template_code", sa.String(length=100), nullable=True),
            sa.Column("sent_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("failed_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("delivered_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("opened_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("clicked_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("result_meta", JSONB, nullable=True),
            sa.Column("scheduled_at", TS, nullable=True),
            sa.Column("sent_at", TS, nullable=True),
            sa.Column("claim_token", UUID, nullable=True),
            sa.Column("claim_expires_at", TS, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "channel IN ('email','sms','alimtalk','push')",
                name="ck_event_messages_channel",
            ),
            sa.CheckConstraint(
                "message_type IN ('informational','advertising')",
                name="ck_event_messages_message_type",
            ),
            sa.CheckConstraint(
                "status IN ('draft','scheduled','queued','sending','sent',"
                "'sent_with_failures','failed','requires_review')",
                name="ck_event_messages_status",
            ),
        )
        op.create_index("idx_event_messages_account", "event_messages", ["account_id"])
        op.create_index("idx_event_messages_event", "event_messages", ["event_id"])
        # go 185: 부분 인덱스 (queued/sending 만) — dispatch cron 스캔 최적화.
        op.create_index(
            "idx_event_messages_dispatch",
            "event_messages",
            ["status", "created_at"],
            postgresql_where=sa.text("status IN ('queued', 'sending')"),
        )
        # go 199: 캠페인 실행 claim lease (sending 만).
        op.create_index(
            "ix_event_messages_claim_lease",
            "event_messages",
            ["status", "claim_expires_at"],
            postgresql_where=sa.text("status = 'sending'"),
        )

    # ── 3) message_deliveries (go 184/187/193/197/201) ───────────────────────
    if not _has_table(insp, "message_deliveries"):
        op.create_table(
            "message_deliveries",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("message_id", UUID, nullable=False),
            sa.Column(
                "source", sa.String(length=20), nullable=False, server_default=sa.text("'message'")
            ),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("channel", sa.String(length=20), nullable=False),
            sa.Column("contact", sa.Text(), nullable=False),
            sa.Column(
                "status", sa.String(length=20), nullable=False, server_default=sa.text("'queued'")
            ),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("request_id", sa.Text(), nullable=True),
            sa.Column("delivered_at", TS, nullable=True),
            sa.Column("opened_at", TS, nullable=True),
            sa.Column("clicked_at", TS, nullable=True),
            sa.Column("failover_channel", sa.String(length=20), nullable=True),
            sa.Column("claim_token", UUID, nullable=True),
            sa.Column("claim_expires_at", TS, nullable=True),
            sa.Column(
                "reconcile_attempts", sa.Integer(), nullable=False, server_default=sa.text("0")
            ),
            sa.Column("reconcile_first_at", TS, nullable=True),
            sa.Column("last_reconciled_at", TS, nullable=True),
            sa.Column("next_reconcile_at", TS, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "source IN ('message','campaign')", name="ck_message_deliveries_source"
            ),
            sa.CheckConstraint(
                "channel IN ('email','sms','kakao')", name="ck_message_deliveries_channel"
            ),
            sa.CheckConstraint(
                "status IN ('queued','sending','sent','delivered','failed','skipped',"
                "'unknown','manual_review','cancelled')",
                name="ck_message_deliveries_status",
            ),
            sa.UniqueConstraint(
                "message_id", "channel", "contact", name="uq_message_deliveries_idem"
            ),
        )
        op.create_index("idx_message_deliveries_account", "message_deliveries", ["account_id"])
        op.create_index(
            "idx_message_deliveries_status", "message_deliveries", ["message_id", "status"]
        )
        # go 184: request_id 부분 인덱스(DLR 조회).
        op.create_index(
            "idx_msg_deliveries_request",
            "message_deliveries",
            ["request_id"],
            postgresql_where=sa.text("request_id IS NOT NULL"),
        )
        # go 187: opened/clicked 부분 인덱스(집계 스캔).
        op.create_index(
            "idx_msg_deliveries_opened",
            "message_deliveries",
            ["message_id"],
            postgresql_where=sa.text("opened_at IS NOT NULL"),
        )
        op.create_index(
            "idx_msg_deliveries_clicked",
            "message_deliveries",
            ["message_id"],
            postgresql_where=sa.text("clicked_at IS NOT NULL"),
        )
        # go 197: claim lease 부분 인덱스(sending stale reclaim).
        op.create_index(
            "ix_message_deliveries_claim_lease",
            "message_deliveries",
            ["status", "claim_expires_at"],
            postgresql_where=sa.text("status = 'sending'"),
        )

    # ── 4) message_delivery_attempts (go 201) ────────────────────────────────
    if not _has_table(insp, "message_delivery_attempts"):
        op.create_table(
            "message_delivery_attempts",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("delivery_id", UUID, nullable=False),
            sa.Column("message_id", UUID, nullable=False),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("channel", sa.String(length=20), nullable=False),
            sa.Column("provider", sa.String(length=40), nullable=False),
            sa.Column("recipient_hash", sa.Text(), nullable=False),
            sa.Column("idempotency_key", sa.Text(), nullable=False),
            sa.Column("claim_token", UUID, nullable=True),
            sa.Column("request_fingerprint", sa.Text(), nullable=True),
            sa.Column("attempt_no", sa.Integer(), nullable=False),
            sa.Column("previous_attempt_id", UUID, nullable=True),
            sa.Column("started_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("finished_at", TS, nullable=True),
            sa.Column("provider_request_id", sa.Text(), nullable=True),
            sa.Column("http_status", sa.Integer(), nullable=True),
            sa.Column("provider_error_code", sa.Text(), nullable=True),
            sa.Column("provider_error_summary", sa.Text(), nullable=True),
            sa.Column(
                "result_status",
                sa.String(length=20),
                nullable=False,
                server_default=sa.text("'inflight'"),
            ),
            sa.Column("timeout_stage", sa.String(length=30), nullable=True),
            sa.Column("ambiguous", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(
                ["delivery_id"], ["message_deliveries.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["previous_attempt_id"], ["message_delivery_attempts.id"]
            ),
            sa.CheckConstraint(
                "channel IN ('email','sms','kakao')",
                name="ck_message_delivery_attempts_channel",
            ),
            sa.CheckConstraint(
                "attempt_no > 0", name="ck_message_delivery_attempts_no_positive"
            ),
            sa.CheckConstraint(
                "result_status IN ('inflight','sent','delivered','failed','unknown',"
                "'manual_review','cancelled')",
                name="ck_message_delivery_attempts_result",
            ),
            sa.UniqueConstraint(
                "delivery_id", "attempt_no", name="uq_message_delivery_attempt_no"
            ),
        )
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_message_delivery_attempts_delivery "
            "ON message_delivery_attempts (delivery_id, created_at DESC)"
        )
        # go 201: unknown/manual_review 부분 인덱스(검토 대상 조회).
        op.create_index(
            "ix_message_delivery_attempts_review",
            "message_delivery_attempts",
            ["result_status", "created_at"],
            postgresql_where=sa.text("result_status IN ('unknown', 'manual_review')"),
        )
        op.create_index(
            "ix_message_delivery_attempts_provider_request",
            "message_delivery_attempts",
            ["provider_request_id"],
            postgresql_where=sa.text("provider_request_id IS NOT NULL"),
        )

    # ── 5) message_delivery_operator_actions (go 201) ────────────────────────
    if not _has_table(insp, "message_delivery_operator_actions"):
        op.create_table(
            "message_delivery_operator_actions",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("delivery_id", UUID, nullable=False),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("actor_id", UUID, nullable=False),
            sa.Column("operation_key", sa.Text(), nullable=False),
            sa.Column("action", sa.String(length=30), nullable=False),
            sa.Column("from_status", sa.String(length=20), nullable=False),
            sa.Column("to_status", sa.String(length=20), nullable=False),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("provider_request_id", sa.Text(), nullable=True),
            sa.Column(
                "result", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")
            ),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(
                ["delivery_id"], ["message_deliveries.id"], ondelete="CASCADE"
            ),
            sa.CheckConstraint(
                "action IN ('manual_review','confirm_sent','confirm_failed','resend','reconcile')",
                name="ck_message_delivery_operator_actions_action",
            ),
            sa.CheckConstraint(
                "length(btrim(reason)) >= 5",
                name="ck_message_delivery_operator_actions_reason",
            ),
            sa.UniqueConstraint(
                "account_id", "operation_key", name="uq_message_delivery_operator_operation"
            ),
        )
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_message_delivery_operator_actions_delivery "
            "ON message_delivery_operator_actions (delivery_id, created_at DESC)"
        )

    # ── 6) message_consents (go 181/194) ─────────────────────────────────────
    if not _has_table(insp, "message_consents"):
        op.create_table(
            "message_consents",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("contact", sa.Text(), nullable=False),
            sa.Column("channel", sa.String(length=20), nullable=False),
            sa.Column("consented", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("consented_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column(
                "night_consented", sa.Boolean(), nullable=False, server_default=sa.text("false")
            ),
            sa.Column("source", sa.Text(), nullable=True),
            sa.Column("first_consented_at", TS, nullable=True),
            sa.Column("wording_version", sa.Text(), nullable=True),
            sa.Column("reconfirm_requested_at", TS, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "channel IN ('email','sms','kakao')", name="ck_message_consents_channel"
            ),
            sa.UniqueConstraint(
                "account_id", "contact", "channel", name="uq_message_consents_scope"
            ),
        )
        # go 194: 2년 재확인 대상 조회용(동의중 + 오래된 동의) 부분 인덱스.
        op.create_index(
            "idx_msg_consents_reconfirm",
            "message_consents",
            ["consented_at"],
            postgresql_where=sa.text("consented = true"),
        )

    # ── 7) message_consent_events (go 194, append-only) ──────────────────────
    if not _has_table(insp, "message_consent_events"):
        op.create_table(
            "message_consent_events",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("contact", sa.Text(), nullable=False),
            sa.Column("channel", sa.String(length=20), nullable=False),
            sa.Column("action", sa.String(length=30), nullable=False),
            sa.Column("consented", sa.Boolean(), nullable=False),
            sa.Column(
                "night_consented", sa.Boolean(), nullable=False, server_default=sa.text("false")
            ),
            sa.Column("wording_version", sa.Text(), nullable=True),
            sa.Column("source", sa.Text(), nullable=True),
            sa.Column("occurred_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "channel IN ('email','sms','kakao')",
                name="ck_message_consent_events_channel",
            ),
            sa.CheckConstraint(
                "action IN ('grant','withdraw','reconfirm_requested','expire')",
                name="ck_message_consent_events_action",
            ),
        )
        op.execute(
            "CREATE INDEX IF NOT EXISTS idx_consent_events_contact "
            "ON message_consent_events (account_id, contact, channel, occurred_at DESC)"
        )

    # ── 8) message_suppressions (go 182) — COALESCE 전역 유니크 ──────────────
    if not _has_table(insp, "message_suppressions"):
        op.create_table(
            "message_suppressions",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("account_id", UUID, nullable=True),  # NULL = 전역
            sa.Column("contact", sa.Text(), nullable=False),
            sa.Column("channel", sa.String(length=20), nullable=False),
            sa.Column(
                "reason",
                sa.String(length=20),
                nullable=False,
                server_default=sa.text("'unsubscribe'"),
            ),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "channel IN ('email','sms','kakao','all')",
                name="ck_message_suppressions_channel",
            ),
            sa.CheckConstraint(
                "reason IN ('unsubscribe','bounce','complaint','manual')",
                name="ck_message_suppressions_reason",
            ),
        )
        # go 182: 전역(account NULL) 중복도 하나로 억제되게 COALESCE 표현식 유니크(원문 DDL).
        op.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_suppress_uniq "
            "ON message_suppressions ("
            "  COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), "
            "  contact, channel)"
        )
        op.create_index("idx_msg_suppress_contact", "message_suppressions", ["contact"])

    # ── 9) reminder_sends (go 191/195) ───────────────────────────────────────
    if not _has_table(insp, "reminder_sends"):
        op.create_table(
            "reminder_sends",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("event_id", UUID, nullable=False),
            sa.Column("attendee_id", UUID, nullable=False),
            sa.Column("reminder_type", sa.String(length=20), nullable=False),
            sa.Column("occurrence_date", sa.Date(), nullable=False),
            sa.Column("sent_at", TS, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "reminder_type IN ('D7','D1','CHECKIN')", name="ck_reminder_sends_type"
            ),
            sa.UniqueConstraint(
                "event_id",
                "attendee_id",
                "reminder_type",
                "occurrence_date",
                name="uq_reminder_sends_idem",
            ),
        )
        op.create_index(
            "idx_reminder_sends_event", "reminder_sends", ["event_id", "occurrence_date"]
        )
        # go 195: 선claim 후 미발송(크래시) 스윕용 부분 인덱스.
        op.create_index(
            "idx_reminder_sends_pending",
            "reminder_sends",
            ["created_at"],
            postgresql_where=sa.text("sent_at IS NULL"),
        )

    # ── 10) organizer_webhooks / organizer_webhook_logs (go 053) ─────────────
    if not _has_table(insp, "organizer_webhooks"):
        op.create_table(
            "organizer_webhooks",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("account_id", UUID, nullable=False),
            sa.Column("event_id", UUID, nullable=True),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("endpoint_url", sa.Text(), nullable=False),
            sa.Column("signing_secret", sa.Text(), nullable=False),
            sa.Column(
                "status", sa.String(length=20), nullable=False, server_default=sa.text("'active'")
            ),
            sa.Column(
                "subscribed_events",
                JSONB,
                nullable=False,
                server_default=sa.text("'[]'::jsonb"),
            ),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
        )
        op.create_index("idx_organizer_webhooks_account", "organizer_webhooks", ["account_id"])
        op.create_index("idx_organizer_webhooks_event", "organizer_webhooks", ["event_id"])

    if not _has_table(insp, "organizer_webhook_logs"):
        op.create_table(
            "organizer_webhook_logs",
            sa.Column("id", UUID, primary_key=True),
            sa.Column("webhook_id", UUID, nullable=False),
            sa.Column("event_type", sa.Text(), nullable=False),
            sa.Column(
                "payload", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")
            ),
            sa.Column("response_status", sa.Integer(), nullable=True),
            sa.Column("response_body", sa.Text(), nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(
                ["webhook_id"], ["organizer_webhooks.id"], ondelete="CASCADE"
            ),
        )
        op.create_index(
            "idx_organizer_webhook_logs_webhook", "organizer_webhook_logs", ["webhook_id"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    # 자식 → 부모 순 드롭(FK 역순).
    for table in (
        "organizer_webhook_logs",
        "organizer_webhooks",
        "reminder_sends",
        "message_suppressions",
        "message_consent_events",
        "message_consents",
        "message_delivery_operator_actions",
        "message_delivery_attempts",
        "message_deliveries",
        "event_messages",
        "organizer_notifications",
    ):
        if _has_table(insp, table):
            op.drop_table(table)
