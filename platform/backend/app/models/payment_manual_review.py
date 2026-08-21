"""결제 수동확인 원장 — "조용히 사라지지 않는다"(I1)를 성립시키는 곳.

## 왜 로그가 아니라 테이블인가

지금까지 결제 대사가 판단을 못 하면 **로그만 남기고 지나갔다.** 로그는
① 운영자가 찾아보지 않으면 없는 것과 같고 ② 보존기간이 지나면 사라지며
③ "처리했다/안 했다" 상태가 없어 같은 건을 몇 번이고 다시 본다.

돈이 걸린 미결은 **검색 가능하고 종결 가능한 레코드**여야 한다.

## 🔴 기록이 먼저, 알림은 나중

운영 알림(슬랙·메일)이 실패해도 이 레코드는 남아야 한다. 그래서
`record_manual_review` 는 **자기 트랜잭션으로 먼저 커밋**하고 알림은 그 뒤에 시도한다.
알림 실패는 레코드를 되돌리지 않는다.

## 종결

자동으로 닫지 않는다. 사람이 PG 원장과 대조한 뒤 `resolved` 로 바꾼다.
자동 수렴(C3)이 켜지면 그 경로가 닫을 수 있으나, **그때도 "무슨 근거로 닫았는지"**
를 `resolution` 에 남긴다.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import JSON, DateTime, Index, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID

# 🔴 SQLite(테스트)에서는 JSONB 를 렌더할 수 없다 — 리포 관례대로 variant 를 쓴다
#    (ab_test.py·delegation_token.py 와 같은 형태). 안 하면 테스트 DB 생성이
#    통째로 깨진다(실측: setup 에서 204건 에러).
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.core.database import Base


class ManualReviewKind(str, PyEnum):
    """무엇을 확인해야 하는가."""

    # PG 조회가 타임아웃·5xx 로 실패했다. **거래가 없다는 뜻이 아니다**(F17).
    LOOKUP_FAILED = "lookup_failed"
    # PG 는 결제됐다는데 주문이 아직 미확정이다. 자동수렴 전에는 사람이 본다.
    PAID_BUT_UNCONFIRMED = "paid_but_unconfirmed"
    # PG 는 결제됐는데 주문이 이미 만료·취소·환불이다. 티켓을 되살리면 안 된다.
    PAID_ON_TERMINAL_ORDER = "paid_on_terminal_order"
    # 한 주문에 결제된 TID 가 둘 이상이다. 하나만 확정하고 나머지는 취소해야 한다.
    DUPLICATE_PAID_TID = "duplicate_paid_tid"
    # 조회 응답이 우리가 아는 형태가 아니다(미지 상태·금액/TID/Moid 불일치).
    INCONSISTENT_PG_RESPONSE = "inconsistent_pg_response"
    # PG 가 "그런 거래 없다" 고 확답했다. 승인 전에 죽었으면 정상이지만, 한 번으로
    # 단정하지 않는다 — 반복 확인(grace) 후에야 종결한다. seen_count 가 그 카운터다.
    CHARGE_ABSENT_IN_PG = "charge_absent_in_pg"


class ManualReviewStatus(str, PyEnum):
    OPEN = "open"
    RESOLVED = "resolved"


class PaymentManualReview(Base):
    """결제 미결 건 — 사람이 PG 원장과 대조해 종결한다."""

    __tablename__ = "payment_manual_reviews"
    __table_args__ = (
        # 🔴 같은 건이 드레인마다 새 행을 만들지 않게 한다. 드레인 주기가 1~5분이라
        #    이게 없으면 하루 수백 행이 쌓여 **정작 봐야 할 것이 묻힌다.**
        #    종결된 건은 제약 밖이므로, 같은 문제가 재발하면 새로 열린다.
        Index(
            "uq_manual_review_open",
            "payment_attempt_id",
            "kind",
            unique=True,
            postgresql_where=text("status = 'open'"),
            sqlite_where=text("status = 'open'"),
        ),
        # payment_attempt_id=NULL rows need their own identities: PostgreSQL
        # considers NULL values distinct, so the index above cannot absorb them.
        Index(
            "uq_manual_review_open_order_only",
            "order_id",
            "kind",
            unique=True,
            postgresql_where=text(
                "status = 'open' AND payment_attempt_id IS NULL AND order_id IS NOT NULL"
            ),
            sqlite_where=text(
                "status = 'open' AND payment_attempt_id IS NULL AND order_id IS NOT NULL"
            ),
        ),
        Index(
            "uq_manual_review_open_tid_only",
            "pg_transaction_id",
            "kind",
            unique=True,
            postgresql_where=text(
                "status = 'open' AND payment_attempt_id IS NULL "
                "AND order_id IS NULL AND pg_transaction_id IS NOT NULL"
            ),
            sqlite_where=text(
                "status = 'open' AND payment_attempt_id IS NULL "
                "AND order_id IS NULL AND pg_transaction_id IS NOT NULL"
            ),
        ),
        Index("idx_manual_review_status_created", "status", "created_at"),
        Index("idx_manual_review_tid", "pg_transaction_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # 🔴 FK 를 걸지 않는다. 이 원장은 **주문이 사라져도 남아야 한다** — 돈이 오간
    #    사실의 기록이지 주문의 부속물이 아니다.
    order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    payment_attempt_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    # 사람이 PG 콘솔에서 찾을 때 쓰는 두 키. 없으면 대조 자체가 불가능하다.
    pg_transaction_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    payment_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(40), nullable=True)

    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ManualReviewStatus.OPEN.value
    )

    detail: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # 알림을 실제로 보냈는가. 🔴 이 값이 NULL 이어도 레코드는 유효하다 —
    # 알림 실패가 기록을 무효화하지 않는다(F32).
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    seen_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    resolution: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
