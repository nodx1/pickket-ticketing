"""카드사 자동할인 설정 — events.card_discounts 가산 추가 (T13~T15)

목표: "고객이 결제 UI 에서 비씨카드를 고르면 자동 10% 할인"(대표 결정 = (A) 결제수단 선택형).

이 컬럼은 **UI 노출 여부와 할인율**만 담는다. 실제 금액 차감은 이벤트 스코프
`discount_codes` 행이 하고, v2 주문생성이 그 코드로 **재계산**한다.

  {"BC": {"rate": 10, "discount_code": "<불투명 코드>"}}
  NULL = 카드사 할인 없음(현행 동작 불변)

🔴 금액을 여기서 계산하지 않는 이유:
   v2 주문생성은 `net_total = gross - discount_amount(DiscountCode 기반)` 로 **재계산해
   검증**한다(internal_commerce.py). go 가 임의로 깎은 금액을 보내면 AMOUNT_MISMATCH 로
   주문이 거절된다 — 이건 go 가 가격을 주장하지 못하게 만든 설계된 방어선이다.
   그래서 할인은 **v2 가 아는 수단(discount_codes)** 으로 표현하고, 이 컬럼은
   "어떤 카드사에 얼마를, 어떤 코드로" 라는 **매핑**만 갖는다.

⚠️ `allowed_pay_methods`(allowpm1_0724)와 축이 다르다 —
   그쪽은 결제수단(CARD/BANK/VBANK…), 이쪽은 **카드사**(BC). 섞지 않는다.

⚠️ `discount_policies` 를 재사용하지 않은 이유: 그쪽은 국가유공자·장애인 등
   **자격기반 할인** 전용이고 증빙 검증(discount_verification_service)이 붙는다.

가산적·비파괴 — nullable, server_default 없음, 백필 없음.
PG11+ 에서 메타데이터 전용(테이블 재작성 없음). 기존 행은 NULL = 할인 없음.
컬럼 존재 가드로 재실행 안전.

Revision ID: carddisc_0728
Revises: nice_mrg_0728
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB

revision = "carddisc_0728"
down_revision = "nice_mrg_0728"
branch_labels = None
depends_on = None

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    if "card_discounts" not in existing:
        op.add_column("events", sa.Column("card_discounts", _JSON_TYPE, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    if "card_discounts" in existing:
        op.drop_column("events", "card_discounts")
