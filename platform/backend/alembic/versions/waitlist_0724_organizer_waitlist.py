"""레벨2 컷오버(스코프A) — 주최자 대기열(Waitlist) v2 신설

go `waitlist_entries` 워크플로(마이그 033/216)를 v2 정본으로 이관한다.
소비자 액면가 대기열(waitlist_entries, WaitlistEntryModel)과 **별개 테이블**
(organizer_waitlist_entries)로 신설 — 이름 충돌·의미 혼동 회피.

상태머신: waiting → offered → converted | cancelled | expired
  - offer_token_version: 재발송 시 증가(딥링크 HMAC 무효화)
  - converted_order_id: offered→converted 주문 앵커(go orders.id, 멱등 재생)

가산적(additive)·비파괴 — 테이블 존재 가드로 재실행 안전.

Revision ID: waitlist_0724
Revises: bizverif_0724
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "waitlist_0724"
down_revision = "bizverif_0724"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())

    if "organizer_waitlist_entries" not in existing:
        op.create_table(
            "organizer_waitlist_entries",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("account_id", UUID(as_uuid=True), nullable=False),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            sa.Column("product_id", UUID(as_uuid=True), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("email", sa.Text(), nullable=False),
            sa.Column("phone", sa.Text(), nullable=True),
            sa.Column("status", sa.String(length=16), nullable=False,
                      server_default="waiting"),
            sa.Column("offered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("offer_token_version", sa.Integer(), nullable=False,
                      server_default="0"),
            sa.Column("converted_order_id", UUID(as_uuid=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.UniqueConstraint("event_id", "product_id", "email",
                                name="uq_org_waitlist_event_product_email"),
            sa.CheckConstraint(
                "status IN ('waiting','offered','converted','cancelled','expired')",
                name="ck_org_waitlist_status",
            ),
        )
        op.create_index("ix_org_waitlist_account_event",
                        "organizer_waitlist_entries",
                        ["account_id", "event_id", "status"])
        op.create_index("ix_org_waitlist_offer_expiry",
                        "organizer_waitlist_entries",
                        ["status", "expires_at"])


def downgrade() -> None:
    op.drop_table("organizer_waitlist_entries")
