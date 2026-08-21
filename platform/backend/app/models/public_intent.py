"""공개 랜딩 부속기능(무료 RSVP·단체예약 문의) 리드/의향 모델 — 상세통합 트랙B U3.

go 공개 랜딩(`/e/<slug>`)의 RSVP·그룹부킹을 consumer 로 이식하기 위한 v2 수신 원장.

설계:
  - RSVP·그룹부킹은 **판매/발권 SSOT(order/ticket) 를 건드리지 않는 리드(의향) 신청**이다.
    무료 참석 의향·단체 견적 문의를 수집할 뿐이므로, 주문/티켓 상태머신과 독립된 가산 테이블로
    저장한다(비파괴 — 기존 커머스 경로 무영향).
  - 둘 다 consumer 가 **로그인 없이** 제출하는 공개 진입점이 수신한다(봇방지+IP rate_limit).
  - 멱등/중복차단: RSVP 는 (event_id, email) UNIQUE 로 동일인 재신청을 원장 레벨에서 차단(취소 제외).
  - 게이트: events.rsvp_enabled / events.group_booking_enabled(주최자 opt-in, go→v2 write-through)로
    비활성 이벤트의 제출을 서버가 거부한다.

⚠️ v2 attendances 모델은 ticket_id(발권)·user_id(회원) 를 필수로 요구하는 **체크인 원장**이므로,
   사전 무료참석 리드에는 부적합하다 → 전용 RsvpRegistration 을 둔다(설계 근거).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RsvpRegistration(Base):
    """무료 참석(RSVP) 의향 신청 — consumer 공개 진입점이 수신.

    status: pending(승인제 대기) | confirmed(자동확정) | cancelled.
    (event_id, email) UNIQUE(취소 제외가 아니라 원장 전체) — 동일 이메일 재신청은 409.
    취소 후 재신청 UX 는 U3 범위 밖(consumer UI 단계) — 원장은 단순 유지.
    """

    __tablename__ = "rsvp_registrations"
    __table_args__ = (
        # 동일 이벤트에 동일 이메일 1건(멱등·중복차단). 재신청 409.
        UniqueConstraint("event_id", "email", name="uq_rsvp_event_email"),
        Index("ix_rsvp_registrations_event", "event_id"),
        # F8: status 무결성(DB CHECK). unify8_0723 마이그레이션과 정합.
        CheckConstraint(
            "status IN ('pending', 'confirmed', 'cancelled')",
            name="ck_rsvp_registrations_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 정규화된 소문자 이메일(소유증명·중복키 기준).
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="confirmed", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class GroupBookingRequest(Base):
    """단체 예약 문의(견적 리드) — consumer 공개 진입점이 수신 + 주최자 통지.

    실제 좌석 할당/결제가 아니라 '연락 요청'이다(go group_bookings 의 리드 성격 이식).
    status: pending(접수) | contacted | closed. 주최자가 후속 처리(연락).
    tier_id 는 희망 등급(optional) — v2 seat_tiers.id 또는 미지정.
    """

    __tablename__ = "group_booking_requests"
    __table_args__ = (
        Index("ix_group_booking_requests_event", "event_id"),
        # F8: status 무결성(DB CHECK). unify8_0723 마이그레이션과 정합.
        CheckConstraint(
            "status IN ('pending', 'contacted', 'closed')",
            name="ck_group_booking_requests_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    organization_name: Mapped[str] = mapped_column(String(200), nullable=False)
    contact_name: Mapped[str] = mapped_column(String(200), nullable=False)
    contact_email: Mapped[str] = mapped_column(String(320), nullable=False)
    contact_phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    attendee_count: Mapped[int] = mapped_column(Integer, nullable=False)
    # 희망 등급(consumer 노출 tier). 미지정 가능. FK 없음(등급 삭제와 무관하게 문의 이력 보존).
    tier_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
