"""merge level2 go-unique branches: go_audit_tenant_idx + organizer_waitlist

레벨2 컷오버(go 고유 이관) 1배치 — Audit(goaudit_0724)·Waitlist(waitlist_0724)가
각각 bizverif_0724 위에서 분기 → 두 head를 병합해 레벨2 단일 head로 잇는다.
스키마 변경 없음(순수 merge).

Revision ID: lvl2gu_mrg_0724
Revises: goaudit_0724, waitlist_0724
Create Date: 2026-07-24
"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = "lvl2gu_mrg_0724"
down_revision = ("goaudit_0724", "waitlist_0724")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
