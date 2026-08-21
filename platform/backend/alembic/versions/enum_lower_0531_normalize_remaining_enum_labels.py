"""normalize remaining enum labels to lowercase (ordertype/transfertype/eventstaffrole)

e1f6a9d4c3b2가 일부만 정규화(ordertype은 DEPOSIT만, transfertype은 미처리)해서
모델은 values_callable로 소문자 .value를 전송하는데 DB enum 라벨은 대문자로 남아
PostgreSQL에서 주문(order_type='purchase') INSERT가 InvalidTextRepresentationError로 전량 실패.
SQLite 테스트(enum=VARCHAR)로는 안 잡히는 PG-only 버그. 멱등 RENAME으로 잔여 전부 정규화.

Revision ID: enum_lower_0531
Revises: category_ssot_0531
Create Date: 2026-05-31
"""
from alembic import op

revision = "enum_lower_0531"
down_revision = "category_ssot_0531"
branch_labels = None
depends_on = None

# (enum_type, UPPER_label, lower_label)
_RENAMES = [
    ("ordertype", "PURCHASE", "purchase"),
    ("ordertype", "RESALE_BUY", "resale_buy"),
    ("ordertype", "RESALE_SELL", "resale_sell"),
    ("ordertype", "DEPOSIT", "deposit"),
    ("transfertype", "PRIMARY_SALE", "primary_sale"),
    ("transfertype", "RESALE", "resale"),
    ("transfertype", "GIFT", "gift"),
    ("transfertype", "CANCELLATION_REFUND", "cancellation_refund"),
    ("eventstaffrole", "CHECKIN", "checkin"),
    ("eventstaffrole", "SUPERVISOR", "supervisor"),
]


def _rename(typ: str, old: str, new: str) -> str:
    # 멱등: old(대문자)가 존재할 때만 RENAME. 이미 소문자면 no-op.
    return f"""
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = '{typ}' AND e.enumlabel = '{old}'
          ) THEN
            ALTER TYPE {typ} RENAME VALUE '{old}' TO '{new}';
          END IF;
        END $$;
    """


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # SQLite 등은 enum이 VARCHAR라 무관
    for typ, old, new in _RENAMES:
        op.execute(_rename(typ, old, new))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for typ, old, new in _RENAMES:
        op.execute(_rename(typ, new, old))  # 역방향: 소문자 → 대문자
