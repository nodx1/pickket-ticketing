"""DEPRECATED: AuditEntryModel — WP-16에서 AuditLog로 통합.

이 모델은 하위 호환을 위해 유지되지만, 신규 감사 로그는
app.core.audit.write_audit_log() 또는 app.models.audit_log.AuditLog를 사용하세요.
audit_entries 테이블은 향후 정리 단계에서 제거될 예정입니다.
"""

import json
import uuid
import warnings
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import String, ForeignKey, DateTime, JSON, TypeDecorator
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class _DecimalSafeJSON(TypeDecorator):
    """JSON column that converts Decimal to float on serialization."""

    impl = JSONB
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())

    class _Encoder(json.JSONEncoder):
        def default(self, o):
            if isinstance(o, Decimal):
                return float(o)
            if isinstance(o, uuid.UUID):
                return str(o)
            return super().default(o)

    def process_bind_param(self, value, dialect):
        if value is not None:
            return json.loads(json.dumps(value, cls=self._Encoder))
        return None

    def process_result_value(self, value, dialect):
        return value


class AuditEntryModel(Base):
    """DEPRECATED: Use AuditLog via write_audit_log() instead.

    WP-16에서 AuditLog(audit_logs)로 통합됨.
    하위 호환을 위해 유지하며, 신규 코드에서는 사용하지 마세요.
    """

    __tablename__ = "audit_entries"

    def __init_subclass__(cls, **kwargs):
        warnings.warn(
            "AuditEntryModel is deprecated. Use AuditLog via write_audit_log() instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        super().__init_subclass__(**kwargs)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    tier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="SET NULL"), nullable=True
    )
    sale_mode: Mapped[str | None] = mapped_column(String(50), nullable=True)
    details: Mapped[dict | None] = mapped_column(_DecimalSafeJSON, nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    admin_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, default=None
    )
    result: Mapped[str] = mapped_column(String(50), default="success")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
