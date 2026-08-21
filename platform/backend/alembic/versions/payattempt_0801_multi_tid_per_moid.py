"""payment_attempts: 한 주문(Moid)에 TID 가 여럿일 수 있게

Revision ID: payattempt_0801
Revises: phoneidx_0731
Create Date: 2026-08-01

## 왜

나이스 결제 복구 안전망을 붙이려면 **승인 호출 전에** (주문·Moid·TID) 를 별도
트랜잭션으로 커밋해둬야 한다. 그래야 확정 커밋이 깨져도 그 TID 로 PG 에 물어볼 수
있다(지금은 TID 가 확정 커밋과 함께 저장되므로, 커밋이 깨지면 조회 키 자체가 없다).

그런데 나이스 Moid 는 `order.payment_id or generate_payment_id(order.id)` 로
**주문당 고정**이다. 손님이 인증을 다시 타면 같은 Moid 에 **다른 TxTid** 가 붙는다.
현재 `uq_payment_attempts_payment_id`(payment_id UNIQUE)가 그 두 번째 행을 막는다.

## 무엇을

payment_id 전역 UNIQUE 를 **두 개의 부분 유니크**로 쪼갠다.

    pg_transaction_id IS NULL      → UNIQUE(payment_id)
        원클릭(빌링키) 경로가 쓰는 형태 그대로다. 그 경로는 PG 호출 전에 TID 를
        모르므로 NULL 로 시작하고, payment_id 에 attempt_no 가 박혀 있어 시도마다
        값이 다르다. 종전 안전망을 **그대로 보존**한다.

    pg_transaction_id IS NOT NULL  → UNIQUE(payment_id, pg_transaction_id)
        나이스 인증결제가 쓰는 형태다. 같은 Moid 에 TID 가 여럿 붙는 것은 허용하되,
        **같은 (Moid, TID) 가 두 행이 되는 것은 막는다** — return POST 재전송에
        대한 멱등이 이 제약에서 나온다.

## 🔴 이 마이그레이션이 여는 것과 열지 않는 것

여는 것: 한 주문에 승인 시도 기록이 여럿 남을 수 있다.
열지 않는 것: **같은 Moid 로 승인이 두 번 나가는 것.** 그건 코드가 막는다
  (미해결 선행 TID 가 있으면 재승인하지 않는다). 나이스가 Moid 중복 승인을
  거부하는지 스펙에 없어, 답에 의존하지 않는 쪽으로 설계했다.

## 온라인 안전성

기존 인덱스를 drop 하고 부분 인덱스 2개를 만든다. 테이블 재작성은 없다.
⚠️ 되돌릴 때 payment_id 가 중복된 행이 이미 있으면 전역 UNIQUE 재생성이 실패한다.
   downgrade 는 그 사실을 감추지 않고 그대로 실패시킨다(조용히 데이터를 지우지 않는다).
"""
from alembic import op
import sqlalchemy as sa

revision = "payattempt_0801"
down_revision = "phoneidx_0731"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("uq_payment_attempts_payment_id", table_name="payment_attempts")
    op.create_index(
        "uq_payment_attempts_payment_id_no_tid",
        "payment_attempts",
        ["payment_id"],
        unique=True,
        postgresql_where=sa.text("pg_transaction_id IS NULL"),
    )
    op.create_index(
        "uq_payment_attempts_payment_tid",
        "payment_attempts",
        ["payment_id", "pg_transaction_id"],
        unique=True,
        postgresql_where=sa.text("pg_transaction_id IS NOT NULL"),
    )
    # 🔴 TID 전역 유니크 (2026-08-01, 코덱스 F16 지적).
    #    위 (payment_id, TID) 유니크는 **같은 Moid 안에서만** 중복을 막는다.
    #    서로 다른 주문의 return 에 **같은 TID** 를 쓰는 것은 통과했다(실 PG 로 확인).
    #    TID 는 나이스가 거래마다 발급하므로 두 주문이 정당하게 공유할 일이 없다.
    #    서명 검증이 1차로 막지만, 그것을 유일한 방어선으로 두지 않는다.
    op.create_index(
        "uq_payment_attempts_tid_global",
        "payment_attempts",
        ["pg_transaction_id"],
        unique=True,
        postgresql_where=sa.text("pg_transaction_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_payment_attempts_tid_global", table_name="payment_attempts")
    op.drop_index("uq_payment_attempts_payment_tid", table_name="payment_attempts")
    op.drop_index("uq_payment_attempts_payment_id_no_tid", table_name="payment_attempts")
    # 🔴 같은 payment_id 행이 둘 이상이면 여기서 실패한다. 정상이다 —
    #    되돌리려면 어느 행을 남길지 사람이 정해야 한다.
    op.create_index(
        "uq_payment_attempts_payment_id",
        "payment_attempts",
        ["payment_id"],
        unique=True,
    )
