"""감사 로그 (Audit Trail) 통합 모델 — Phase C WP-C3 + WP-16 통합.

WP-16: AuditEntryModel(audit_entries)과 AuditLog(audit_logs) 이중 감사 시스템을
AuditLog 단일 모델로 통합. event_id, tier_id, sale_mode 컬럼 추가.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, String, DateTime, ForeignKey, Text, JSON, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_actor_created", "actor_id", "created_at"),
        # 정합보강(마이그 guest4_0723): actor_type 값도메인 고정. NULL 허용(가산 컬럼·기존 행 무영향).
        # 코드는 'user'/'guest'/'admin'/'system' 만 사용 — 임의 문자열 저장 차단.
        CheckConstraint(
            "actor_type IS NULL OR actor_type IN "
            "('user', 'guest', 'admin', 'system')",
            name="ck_audit_logs_actor_type_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    resource_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    resource_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    old_value: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    new_value: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )

    # WP-16: AuditEntryModel 호환 컬럼 (이벤트/판매 스코프 감사)
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    tier_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    sale_mode: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # 상세통합 S1(§7.2): 게스트 감사 수용. actor_id 는 users FK 라 게스트 불가였음.
    # actor_type = 행위자 종류(user/guest/admin/system 등), guest 행위는 guest_id 로 기록.
    # ⚠️ immutable 트리거(trg_audit_logs_no_update/no_delete)는 DB 레벨 — 건드리지 않음(가산 컬럼만).
    actor_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    guest_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("guests.id", ondelete="SET NULL"), nullable=True, index=True
    )
