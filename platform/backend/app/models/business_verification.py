"""사업자 인증 심사 모델 (레벨2 2차 D4 — go 흡수 신설).

go organizer 는 `business_verifications`(+documents) 에 사업자 문서 업로드·상태머신
(draft/pending/approved/rejected)을 가졌으나 v2 엔 accounts.business_number + approve 뿐이라
문서 업로드/심사 상태머신이 없었다. go DB 완전 제거를 위해 v2 에 정본으로 신설한다.

키:
- go_account_id: go accounts.id (테넌트 경계). 프록시 조회/집계는 반드시 이 값으로 스코프.
- organizer_profile_id: v2 OrganizerProfile 링크(있으면). 승인 게이트 정본은 이 원장이며
  v2 유료 발행 게이트가 최신 approved 여부를 참조.

상태머신:
    draft ──submit──▶ pending ──approve──▶ approved
                          │
                          └──reject──▶ rejected ──(재제출 save)──▶ draft
    approved/pending 은 편집 잠금(save/submit 거부). rejected/unverified/draft 만 편집.

문서 스토리지: 기존 v2 업로드(MinIO/cdn.pickket.kr, upload_service) key 재사용 —
file_url(public) + storage_key(provider key) 를 함께 보관.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class BizVerificationStatus(str, PyEnum):
    """사업자 인증 심사 상태머신."""

    DRAFT = "draft"
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class BizDocType(str, PyEnum):
    """제출 서류 유형."""

    BIZ_CERT = "biz_cert"   # 사업자등록증
    BANKBOOK = "bankbook"   # 통장 사본
    PERMIT = "permit"       # 인허가증


def _status_enum():
    return Enum(
        BizVerificationStatus,
        values_callable=lambda e: [x.value for x in e],
        native_enum=False,
        length=20,
    )


def _doctype_enum():
    return Enum(
        BizDocType,
        values_callable=lambda e: [x.value for x in e],
        native_enum=False,
        length=20,
    )


class BusinessVerification(Base):
    """사업자 인증 신청·심사 이력. 계정(go_account_id) 1:N (재제출 = 새 행, 최신이 유효)."""

    __tablename__ = "business_verifications"
    __table_args__ = (
        Index("ix_bizverif_go_account", "go_account_id"),
        Index("ix_bizverif_status", "status"),
        Index("ix_bizverif_org_profile", "organizer_profile_id"),
        CheckConstraint(
            "status IN ('draft', 'pending', 'approved', 'rejected')",
            name="ck_bizverif_status_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # 테넌트 경계 — go accounts.id. 프록시 조회/집계는 반드시 이 값으로 스코프.
    go_account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    organizer_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizer_profiles.id", ondelete="SET NULL"),
        nullable=True,
    )

    # 사업자 정보 (심사 기간만 보관 — 데이터 최소보관 원칙)
    biz_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    company_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rep_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    biz_type: Mapped[str | None] = mapped_column(String(128), nullable=True)   # 업태
    biz_item: Mapped[str | None] = mapped_column(String(128), nullable=True)   # 종목
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    opened_on: Mapped[datetime | None] = mapped_column(Date, nullable=True)

    # 정산 계좌 (마스킹 표시 + admin 전용)
    bank_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bank_account: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bank_holder: Mapped[str | None] = mapped_column(String(128), nullable=True)
    bank_verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # 확인 플래그
    authorized_confirmed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    masking_confirmed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # 자동심사 결과(향후 P2~P4 — OCR/정부검증/실명/계좌)
    ocr_raw: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    gov_check_result: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    identity_result: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    bank_check_result: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)

    # 심사 상태머신
    status: Mapped[BizVerificationStatus] = mapped_column(
        _status_enum(),
        nullable=False,
        default=BizVerificationStatus.DRAFT,
        server_default=BizVerificationStatus.DRAFT.value,
    )
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    rejected_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    documents: Mapped[list["BusinessVerificationDocument"]] = relationship(
        "BusinessVerificationDocument",
        back_populates="verification",
        cascade="all, delete-orphan",
        order_by="BusinessVerificationDocument.created_at",
    )


class BusinessVerificationDocument(Base):
    """제출 서류(사업자등록증·통장사본·인허가). verification 1:N."""

    __tablename__ = "business_verification_documents"
    __table_args__ = (
        Index("ix_bvd_verification", "verification_id"),
        CheckConstraint(
            "doc_type IN ('biz_cert', 'bankbook', 'permit')",
            name="ck_bvd_doc_type_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    verification_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("business_verifications.id", ondelete="CASCADE"),
        nullable=False,
    )
    doc_type: Mapped[BizDocType] = mapped_column(_doctype_enum(), nullable=False)
    # 스토리지 참조 — public URL + provider key(재서명/삭제용).
    file_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    verification: Mapped["BusinessVerification"] = relationship(
        "BusinessVerification", back_populates="documents"
    )
