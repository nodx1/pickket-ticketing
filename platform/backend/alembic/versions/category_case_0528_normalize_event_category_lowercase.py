"""Normalize event category to lowercase.

§37 P0: Fix case collision — backend stored "CONCERT" while packages/lib uses "concert".
"""

revision = "category_case_0528"
down_revision = "financial_ck_0528"
branch_labels = None
depends_on = None

from alembic import op


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.execute("UPDATE events SET category = LOWER(category) WHERE category <> LOWER(category)")


def downgrade() -> None:
    pass
