"""경품번호 티어 대역 — seat_tiers.raffle_number_base + 티어별 카운터

Revision ID: raffbase_0731
Revises: invseq_0730
Create Date: 2026-07-31

## 왜 (BC카드·한경 KLPGA 요건)
경품번호를 **티어별 대역**으로 발급한다:

    주중권       100001~
    주말권       200001~
    온라인 초대권 500001~

종전은 이벤트당 카운터 하나 + Feistel 뒤섞기라 100000~999999 중 **무작위처럼 보이는**
값이 나왔다(실측: 205108·443903·913508). 대역이 성립하지 않는다.

## 설계 — 규칙을 코드가 아니라 **데이터**로
티어 이름으로 판정하면 이름 한 글자만 바뀌어도 깨지고, 코드에 박으면 다음 대회마다
고쳐야 한다. `seat_tiers.raffle_number_base` 에 시작번호를 두면 주최자가 화면에서
설정할 수 있고 다른 행사에도 그대로 쓴다.

## 추가만 한다 — 기존 경로 무변경
`event_raffle_counters`(이벤트 스코프)는 **그대로 둔다**. base 가 없는 티어는 종전
동작(Feistel 코드)을 유지한다 — 다른 행사가 이미 그 번호로 돌고 있고, 대회 20일 전에
그것까지 바꿀 이유가 없다.
새 카운터는 별도 표(`event_tier_raffle_counters`)로 둔다. 기존 표의 PK 를 (event_id)
에서 (event_id, tier_id) 로 바꾸려면 PK 수술이 필요하고, 그건 되돌리기 어렵다.
"""
from alembic import op
import sqlalchemy as sa

revision = "raffbase_0731"
down_revision = "invseq_0730"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 티어별 경품번호 시작값. NULL = 대역 미사용(종전 Feistel 코드 경로).
    op.add_column(
        "seat_tiers",
        sa.Column("raffle_number_base", sa.Integer(), nullable=True),
    )
    # 대역 시작은 양수여야 한다. 0·음수면 "미사용(NULL)"과 구분이 안 되고,
    # base + 순번이 다른 대역을 침범한다.
    op.create_check_constraint(
        "ck_seat_tiers_raffle_base_positive",
        "seat_tiers",
        "raffle_number_base IS NULL OR raffle_number_base > 0",
    )

    # 티어별 카운터. 예약은 `UPDATE ... SET last_seq = last_seq + :n RETURNING` 단일
    # UPDATE 이고, 그 행잠금이 동시 발권을 직렬화한다(이벤트 카운터와 같은 방식).
    op.create_table(
        "event_tier_raffle_counters",
        sa.Column("event_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tier_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("last_seq", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tier_id"], ["seat_tiers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("event_id", "tier_id"),
        sa.CheckConstraint("last_seq >= 0", name="ck_tier_raffle_counter_seq_nonneg"),
    )


def downgrade() -> None:
    op.drop_table("event_tier_raffle_counters")
    op.drop_constraint("ck_seat_tiers_raffle_base_positive", "seat_tiers", type_="check")
    op.drop_column("seat_tiers", "raffle_number_base")
