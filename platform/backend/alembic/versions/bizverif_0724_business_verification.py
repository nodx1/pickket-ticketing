"""레벨2 2차 D4 — 사업자 인증 심사 v2 신설(business_verifications + documents)

go organizer 는 사업자 문서 업로드·상태머신(draft/pending/approved/rejected)을 go DB 에
가졌으나 v2 엔 accounts.business_number + approve 뿐이었다. go DB 완전 제거를 위해
v2 에 정본으로 신설한다.

- business_verifications: 계정(go_account_id) 1:N, 상태머신, 심사자/사유, 정산계좌, 자동심사 슬롯
- business_verification_documents: verification 1:N, 서류유형·스토리지 참조(file_url/storage_key)

가산적(additive)·비파괴 — 테이블 존재 가드로 재실행 안전. 기존 스키마 무영향.

Revision ID: bizverif_0724
Revises: lvl2mrg_0724
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "bizverif_0724"
down_revision = "lvl2mrg_0724"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())

    if "business_verifications" not in existing:
        op.create_table(
            "business_verifications",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("go_account_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "organizer_profile_id",
                UUID(as_uuid=True),
                sa.ForeignKey("organizer_profiles.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("biz_number", sa.String(length=32), nullable=True),
            sa.Column("company_name", sa.String(length=255), nullable=True),
            sa.Column("rep_name", sa.String(length=128), nullable=True),
            sa.Column("biz_type", sa.String(length=128), nullable=True),
            sa.Column("biz_item", sa.String(length=128), nullable=True),
            sa.Column("address", sa.Text(), nullable=True),
            sa.Column("opened_on", sa.Date(), nullable=True),
            sa.Column("bank_name", sa.String(length=64), nullable=True),
            sa.Column("bank_account", sa.String(length=64), nullable=True),
            sa.Column("bank_holder", sa.String(length=128), nullable=True),
            sa.Column("bank_verified", sa.Boolean(), nullable=False,
                      server_default=sa.text("false")),
            sa.Column("authorized_confirmed", sa.Boolean(), nullable=False,
                      server_default=sa.text("false")),
            sa.Column("masking_confirmed", sa.Boolean(), nullable=False,
                      server_default=sa.text("false")),
            sa.Column("ocr_raw", JSONB(), nullable=True),
            sa.Column("gov_check_result", JSONB(), nullable=True),
            sa.Column("identity_result", JSONB(), nullable=True),
            sa.Column("bank_check_result", JSONB(), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False,
                      server_default="draft"),
            sa.Column(
                "reviewed_by",
                UUID(as_uuid=True),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("rejected_reason", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.CheckConstraint(
                "status IN ('draft', 'pending', 'approved', 'rejected')",
                name="ck_bizverif_status_valid",
            ),
        )
        op.create_index("ix_bizverif_go_account", "business_verifications",
                        ["go_account_id"])
        op.create_index("ix_bizverif_status", "business_verifications", ["status"])
        op.create_index("ix_bizverif_org_profile", "business_verifications",
                        ["organizer_profile_id"])

    if "business_verification_documents" not in existing:
        op.create_table(
            "business_verification_documents",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column(
                "verification_id",
                UUID(as_uuid=True),
                sa.ForeignKey("business_verifications.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("doc_type", sa.String(length=20), nullable=False),
            sa.Column("file_url", sa.String(length=1000), nullable=False),
            sa.Column("storage_key", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.CheckConstraint(
                "doc_type IN ('biz_cert', 'bankbook', 'permit')",
                name="ck_bvd_doc_type_valid",
            ),
        )
        op.create_index("ix_bvd_verification", "business_verification_documents",
                        ["verification_id"])


def downgrade() -> None:
    op.drop_table("business_verification_documents")
    op.drop_table("business_verifications")
