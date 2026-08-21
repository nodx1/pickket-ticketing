"""F4 경품/추첨 모델 — 이벤트별 번호 시퀀스 카운터 + 추첨 실행 원장.

설계 (동시성·감사가능):
- `EventRaffleCounter`: 이벤트당 1행. 발권 시 `UPDATE ... SET last_number = last_number + N
  RETURNING last_number` 로 번호를 원자 예약한다. 행 잠금(UPDATE)이 동시 발권을
  직렬화 → 중복·누락 없이 연속 번호 블록 할당. `tickets` 의 UNIQUE(event_id, raffle_number)
  가 최종 백스톱.
- `RaffleDraw`: 추첨 실행 1회 = 1행. 공개 시드(seed)·당첨 raffle_number 목록·실행 시각·
  실행자·풀 크기를 저장한다. 같은 seed + 같은 풀 → 같은 결과(재현 가능·감사 가능).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class EventRaffleCounter(Base):
    """이벤트별 경품번호 시퀀스 카운터 (F4).

    발권 트랜잭션이 `UPDATE event_raffle_counters SET last_number = last_number + :n
    WHERE event_id = :id RETURNING last_number` 로 [old+1 .. old+n] 블록을 예약한다.
    UPDATE 의 행 잠금이 동시 발권을 직렬화하므로 번호 중복·누락이 없다.
    """

    __tablename__ = "event_raffle_counters"

    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # 마지막으로 발급된 번호(초기 0 → 첫 티켓 = 1).
    last_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class EventTierRaffleCounter(Base):
    """티어별 경품번호 시퀀스 카운터 (F4 대역).

    `seat_tiers.raffle_number_base` 가 있는 티어는 이 카운터로 순번을 받고
    **base + 순번** 을 번호로 쓴다(뒤섞지 않는다 — 대역이 눈에 보여야 한다).

    동시성은 이벤트 카운터와 같은 방식이다: `UPDATE ... SET last_seq = last_seq + :n
    RETURNING` 단일 UPDATE 의 행잠금이 동시 발권을 직렬화한다(중복·누락 0).
    """

    __tablename__ = "event_tier_raffle_counters"

    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), primary_key=True
    )
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="CASCADE"), primary_key=True
    )
    last_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class RaffleDraw(Base):
    """추첨 실행 원장 (F4) — 감사가능·재현가능.

    - `seed`: 공개 시드(published seed). 같은 seed + 같은 풀 → 같은 당첨 결과.
    - `winning_numbers`: 당첨 raffle_number 목록(JSON int 배열, 추첨 순서 보존).
    - `pool_size`: 추첨 시점 풀 크기(=체크인 완료자 수). 감사용 스냅샷.
    - `executed_by`: 실행자(organizer user id 등). go 가 전달.
    """

    __tablename__ = "raffle_draws"
    __table_args__ = (
        UniqueConstraint("event_id", "draw_key", name="uq_raffle_draws_event_key"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    # 멱등 키(선택). 같은 draw_key 로 재실행 시 기존 결과 재생(이중 추첨 방지).
    draw_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    seed: Mapped[str] = mapped_column(String(256), nullable=False)
    winner_count: Mapped[int] = mapped_column(Integer, nullable=False)
    pool_size: Mapped[int] = mapped_column(Integer, nullable=False)
    # 당첨 raffle_number 목록(추첨 순서 보존).
    winning_numbers: Mapped[list] = mapped_column(_JSON_TYPE, nullable=False)
    executed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    executed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
