"""조직자(주최자) 메시징 서브시스템 — v2 흡수 스키마 (레벨2 영역C, 1차 골격).

go(pickket.go)의 조직자용 메시징/알림/발송 테이블을 v2 로 흡수(SSOT 이전)한다. go
notifications(조직자용·account 스코프)는 v2 팬용 notifications(app/models/notification.py,
user 스코프)와 **의미가 완전히 다르므로** 별도 신규 테이블(organizer_notifications)로 만든다.

정본 매핑(go 마이그레이션 → v2 테이블):
  - 073/146 notifications(조직자)     → organizer_notifications
  - 032/183/185~188/192/201 messages  → event_messages(220 수렴형: email_campaigns 미생성)
  - 184/187/193/197/201 deliveries    → message_deliveries (claim-lease·reconcile 포함)
  - 201 attempts / operator actions    → message_delivery_attempts / message_delivery_operator_actions
  - 181/194 consents                   → message_consents / message_consent_events
  - 182 suppressions                   → message_suppressions
  - 191/195 reminder ledger            → reminder_sends
  - 053 webhooks/webhook_logs(조직자)  → organizer_webhooks / organizer_webhook_logs
    (v2 inter_service_webhook_deliveries 와 이름 충돌 회피 위해 organizer_ prefix)
  - 094/183/190/199/200 캠페인          → email_campaigns / email_campaign_recipients (W5-MSG)
  - 098/208 수신함                      → inbound_emails (W5-MSG)
  - 207 provider 대사 식별자            → message_delivery_attempts.provider_lookup_* (W5-MSG)

스코프 규칙(크로스테넌트 경계):
  - `account_id` = 조직자(go account = v2 organizer) 스코프. **bare UUID**(v2 에 accounts
    테이블이 없고, go 흡수 원장은 organizer_profiles FK 로 묶지 않는다 — go 의
    message_delivery_attempts.account_id 도 bare UUID 였음). 모든 목록/집계는 account_id 경계 필수.
  - `event_id` 도 bare UUID(흡수 원장 — v2 events FK 로 강결합하지 않음, 가산·비파괴).

SQLite(테스트) 호환: JSONB/UUID 는 variant 로 폴백. Postgres 전용(부분 인덱스·COALESCE
유니크)은 **모델이 아니라 alembic 리비전(orgmsg_0724)** 에서 원문 DDL 로 재현한다.

⚠️ 알림톡 세션 경계: 이 파일은 **모델·스키마만** 정의한다. 실제 provider 발송(NCP SMS/알림톡)
클라이언트는 알림톡 세션 소유부 — 여기서 import/호출하지 않는다.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# JSONB(prod) / JSON(sqlite test) — 동일 dict API.
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")
# Postgres UUID(as_uuid=True) — conftest 의 @compiles(PG_UUID,"sqlite")→CHAR(32) 로 테스트 호환.
# (variant String 은 UUID 객체 bind 를 깨뜨림 — 코드베이스 전역 컨벤션은 PG UUID 직접 사용.)
_UUID_TYPE = UUID(as_uuid=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ─────────────────────────────────────────────────────────────────────────────
# 1) 조직자 알림 (go 073/146 notifications) — account/organizer 스코프.
#    v2 팬용 notifications(user 스코프)와 별개. 대시보드 인박스용.
# ─────────────────────────────────────────────────────────────────────────────
ORGANIZER_NOTIFICATION_TYPES = (
    # go 073 원형.
    "refund_request",
    "sold_out",
    "payment_failed",
    "new_order",
    "check_in_milestone",
    "system",
    # ── W5-SUPPORT 추가: go 146 이 넓혔던 값들이 v2 흡수 시 누락돼 있었다. ──
    #   go 146 헤더: "073 의 인라인 CHECK 가 ai_review/ai_complete/event_approved/
    #   event_rejected 를 막아 INSERT 가 조용히 실패하던 드리프트 수정".
    #   v2 로 옮기면서 그 수정을 되돌리면 **똑같은 무음 누락이 재발**한다(심사 승인/반려
    #   알림이 통째로 사라짐). 순수 가산 — 기존 6종 동작 불변.
    "ai_review",
    "ai_complete",
    "event_approved",
    "event_rejected",
    # ── 좌석 알림 채널(go lib/notifications/seat-channels.ts) — `seat_${kind}`. ──
    "seat_watch_available",
    "seat_watch_price_drop",
    "seat_companion_invite",
    "seat_hold_expiring",
    "seat_seat_assigned",
    "seat_refund_released",
)

# CHECK 원문 — 위 튜플과 반드시 동기(alembic w5sup_0727 이 동일 목록으로 제약을 교체한다).
_ORG_NOTIF_TYPE_CHECK = "type IN (" + ",".join(f"'{t}'" for t in ORGANIZER_NOTIFICATION_TYPES) + ")"


class OrganizerNotification(Base):
    """조직자 대시보드 알림 — account 스코프. go notifications(조직자) 흡수."""

    __tablename__ = "organizer_notifications"
    __table_args__ = (
        CheckConstraint(
            _ORG_NOTIF_TYPE_CHECK,
            name="ck_organizer_notifications_type",
        ),
        Index("idx_organizer_notifications_account", "account_id"),
        # go idx_notifications_is_read = (account_id, is_read) 재현.
        Index("idx_organizer_notifications_account_read", "account_id", "is_read"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    # 조직자(account) 스코프 — bare UUID(크로스테넌트 경계 키).
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    event_id: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    notif_metadata: Mapped[dict | None] = mapped_column("metadata", _JSON_TYPE, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 2) 이벤트 단체 메시지 (go 032 event_messages, 220 수렴형).
#    email_campaigns 는 만들지 않는다 — 캠페인도 event_messages 로 통일(220).
# ─────────────────────────────────────────────────────────────────────────────
EVENT_MESSAGE_CHANNELS = ("email", "sms", "alimtalk", "push")
EVENT_MESSAGE_TYPES = ("informational", "advertising")
EVENT_MESSAGE_STATUSES = (
    "draft",
    "scheduled",
    "queued",
    "sending",
    "sent",
    "sent_with_failures",
    "failed",
    "requires_review",
)


class EventMessage(Base):
    """이벤트 단체 메시지 헤더 — account/event 스코프. go event_messages(수렴형) 흡수.

    channel: email/sms/alimtalk/push (go 032 원형).
    message_type: informational/advertising (go 183 — 광고성은 컴플라이언스 게이트 적용).
    segment: 세그먼트 타게팅 JSON(go 186). template_code: 알림톡 승인 템플릿(go 188).
    """

    __tablename__ = "event_messages"
    __table_args__ = (
        CheckConstraint(
            "channel IN ('email','sms','alimtalk','push')",
            name="ck_event_messages_channel",
        ),
        CheckConstraint(
            "message_type IN ('informational','advertising')",
            name="ck_event_messages_message_type",
        ),
        CheckConstraint(
            "status IN ('draft','scheduled','queued','sending','sent',"
            "'sent_with_failures','failed','requires_review')",
            name="ck_event_messages_status",
        ),
        Index("idx_event_messages_account", "account_id"),
        Index("idx_event_messages_event", "event_id"),
        # go idx_event_messages_dispatch = (status, created_at) WHERE queued/sending
        # → 부분 인덱스는 alembic 에서 재현. 여기선 비부분 커버 인덱스만.
        Index("idx_event_messages_dispatch", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    event_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    channel: Mapped[str] = mapped_column(String(20), nullable=False)
    message_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="informational"
    )
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="draft")
    body: Mapped[str] = mapped_column(Text, nullable=False)
    recipient_filter: Mapped[str] = mapped_column(String(40), nullable=False, default="all")
    segment: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    template_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    sent_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    delivered_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    opened_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    clicked_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    result_meta: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 캠페인 실행 소유권 lease(go 199 — 여기선 event_messages 로 통일).
    claim_token: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    claim_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 3) 발송 건별(수신자별) 원장 (go 184/187/193/197/201).
#    멱등 UNIQUE(message_id, channel, contact). claim-lease + reconcile 컬럼.
# ─────────────────────────────────────────────────────────────────────────────
DELIVERY_CHANNELS = ("email", "sms", "kakao")
DELIVERY_STATUSES = (
    "queued",
    "sending",
    "sent",
    "delivered",
    "failed",
    "skipped",
    "unknown",
    "manual_review",
    "cancelled",
)


class MessageDelivery(Base):
    """발송 수신자별 상태 원장. (message_id, channel, contact) 멱등.

    status: queued/sending/sent/delivered/failed/skipped/unknown/manual_review/cancelled.
    claim_token/claim_expires_at: stale sending reclaim 소유권(go 197).
    reconcile_*: DLR 대사 스케줄(go 201) — unknown 은 자동 재발송 금지, 대사/수동검토 대상.
    """

    __tablename__ = "message_deliveries"
    __table_args__ = (
        CheckConstraint(
            "source IN ('message','campaign')", name="ck_message_deliveries_source"
        ),
        CheckConstraint(
            "channel IN ('email','sms','kakao')", name="ck_message_deliveries_channel"
        ),
        CheckConstraint(
            "status IN ('queued','sending','sent','delivered','failed','skipped',"
            "'unknown','manual_review','cancelled')",
            name="ck_message_deliveries_status",
        ),
        # 멱등 유니크(go 184).
        UniqueConstraint(
            "message_id", "channel", "contact", name="uq_message_deliveries_idem"
        ),
        Index("idx_message_deliveries_status", "message_id", "status"),
        # 아래 부분 인덱스들은 alembic 에서 postgresql_where 로 재현(request_id/opened/clicked/claim).
        Index("idx_message_deliveries_account", "account_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    # event_messages.id (220 수렴형 — source='message' 로 통일; 'campaign' 은 legacy 호환).
    message_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="message")
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    channel: Mapped[str] = mapped_column(String(20), nullable=False)
    contact: Mapped[str] = mapped_column(Text, nullable=False)  # 정규화된 이메일/전화
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)  # NCP requestId
    # 실추적(go 187).
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    clicked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failover_channel: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # claim lease(go 197).
    claim_token: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    claim_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # reconcile 스케줄(go 201).
    reconcile_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reconcile_first_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_reconciled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    next_reconcile_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 4) provider 호출별 멱등 attempt 원장 + operator 복구 액션 (go 201).
# ─────────────────────────────────────────────────────────────────────────────
ATTEMPT_RESULT_STATUSES = (
    "inflight",
    "sent",
    "delivered",
    "failed",
    "unknown",
    "manual_review",
    "cancelled",
)
OPERATOR_ACTIONS = ("manual_review", "confirm_sent", "confirm_failed", "resend", "reconcile")


class MessageDeliveryAttempt(Base):
    """provider 호출별 멱등 attempt 원장. unknown 은 자동 재발송 금지(수동검토 대상)."""

    __tablename__ = "message_delivery_attempts"
    __table_args__ = (
        CheckConstraint(
            "channel IN ('email','sms','kakao')",
            name="ck_message_delivery_attempts_channel",
        ),
        CheckConstraint("attempt_no > 0", name="ck_message_delivery_attempts_no_positive"),
        CheckConstraint(
            "result_status IN ('inflight','sent','delivered','failed','unknown',"
            "'manual_review','cancelled')",
            name="ck_message_delivery_attempts_result",
        ),
        UniqueConstraint(
            "delivery_id", "attempt_no", name="uq_message_delivery_attempt_no"
        ),
        Index(
            "ix_message_delivery_attempts_delivery",
            "delivery_id",
            text("created_at DESC"),
        ),
        Index("ix_message_delivery_attempts_provider_request", "provider_request_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    delivery_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE,
        ForeignKey("message_deliveries.id", ondelete="CASCADE"),
        nullable=False,
    )
    message_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    channel: Mapped[str] = mapped_column(String(20), nullable=False)
    provider: Mapped[str] = mapped_column(String(40), nullable=False)
    recipient_hash: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    claim_token: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    request_fingerprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_no: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_attempt_id: Mapped[uuid.UUID | None] = mapped_column(
        _UUID_TYPE,
        ForeignKey("message_delivery_attempts.id"),
        nullable=True,
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    provider_request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    provider_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_status: Mapped[str] = mapped_column(String(20), nullable=False, default="inflight")
    timeout_stage: Mapped[str | None] = mapped_column(String(30), nullable=True)
    ambiguous: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # W5-MSG(go 207 흡수): provider 상태조회(DLR) 대사 증적. unknown 대사가 provider 를 몇 번
    # 조회했고 마지막 조회가 어떻게 끝났는지 남긴다 — "조회했는데 못 찾음"과 "조회 자체를 못 함"을
    # 구분하지 못하면 manual_review 판정 근거가 사라진다.
    provider_lookup_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    provider_last_lookup_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    provider_last_lookup_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


class MessageDeliveryOperatorAction(Base):
    """소유자 전용 delivery 복구 액션. operation_key 로 재시도 멱등."""

    __tablename__ = "message_delivery_operator_actions"
    __table_args__ = (
        CheckConstraint(
            "action IN ('manual_review','confirm_sent','confirm_failed','resend','reconcile')",
            name="ck_message_delivery_operator_actions_action",
        ),
        # ⚠️ reason 최소길이 CHECK(length(btrim(reason)) >= 5)는 Postgres 전용(btrim)이라
        # 모델 선언에서 제외하고 alembic 리비전(orgmsg_0724)에서만 생성한다(SQLite 테스트 호환).
        UniqueConstraint(
            "account_id", "operation_key", name="uq_message_delivery_operator_operation"
        ),
        Index(
            "ix_message_delivery_operator_actions_delivery",
            "delivery_id",
            text("created_at DESC"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    delivery_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE,
        ForeignKey("message_deliveries.id", ondelete="CASCADE"),
        nullable=False,
    )
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    actor_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    operation_key: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    from_status: Mapped[str] = mapped_column(String(20), nullable=False)
    to_status: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    provider_request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 5) 마케팅 수신동의 (정보통신망법 §50) — go 181/194.
#    현재상태(message_consents) + append-only 이력(message_consent_events).
# ─────────────────────────────────────────────────────────────────────────────
CONSENT_CHANNELS = ("email", "sms", "kakao")
CONSENT_EVENT_ACTIONS = ("grant", "withdraw", "reconfirm_requested", "expire")


class MessageConsent(Base):
    """마케팅(광고성) 수신동의 현재상태. 정보통신망법 사전동의 근거.

    (account_id, contact, channel) 유일. consented_at = 2년 재확인 기준일.
    first_consented_at/wording_version 는 재동의 시 보존(법정 이력).
    """

    __tablename__ = "message_consents"
    __table_args__ = (
        CheckConstraint(
            "channel IN ('email','sms','kakao')", name="ck_message_consents_channel"
        ),
        UniqueConstraint(
            "account_id", "contact", "channel", name="uq_message_consents_scope"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    contact: Mapped[str] = mapped_column(Text, nullable=False)
    channel: Mapped[str] = mapped_column(String(20), nullable=False)
    consented: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    consented_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    night_consented: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    source: Mapped[str | None] = mapped_column(Text, nullable=True)
    first_consented_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    wording_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    reconfirm_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


class MessageConsentEvent(Base):
    """수신동의 이벤트 원장(append-only). 취득/철회/재확인/만료 법정 이력."""

    __tablename__ = "message_consent_events"
    __table_args__ = (
        CheckConstraint(
            "channel IN ('email','sms','kakao')",
            name="ck_message_consent_events_channel",
        ),
        CheckConstraint(
            "action IN ('grant','withdraw','reconfirm_requested','expire')",
            name="ck_message_consent_events_action",
        ),
        Index(
            "idx_consent_events_contact",
            "account_id",
            "contact",
            "channel",
            text("occurred_at DESC"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    contact: Mapped[str] = mapped_column(Text, nullable=False)
    channel: Mapped[str] = mapped_column(String(20), nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    consented: Mapped[bool] = mapped_column(Boolean, nullable=False)
    night_consented: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    wording_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 6) 수신거부/바운스 억제 (go 182). account_id NULL = 전역.
#    COALESCE 전역 유니크는 alembic 원문 DDL(모델에는 비유니크 인덱스만).
# ─────────────────────────────────────────────────────────────────────────────
SUPPRESSION_CHANNELS = ("email", "sms", "kakao", "all")
SUPPRESSION_REASONS = ("unsubscribe", "bounce", "complaint", "manual")


class MessageSuppression(Base):
    """수신거부/바운스 억제 목록. 발송 전 조회 필수. account_id NULL=전역."""

    __tablename__ = "message_suppressions"
    __table_args__ = (
        CheckConstraint(
            "channel IN ('email','sms','kakao','all')",
            name="ck_message_suppressions_channel",
        ),
        CheckConstraint(
            "reason IN ('unsubscribe','bounce','complaint','manual')",
            name="ck_message_suppressions_reason",
        ),
        # SQLite test schema에는 PostgreSQL 전용 COALESCE expression index를 만들 수 없으므로
        # account-scoped 중복도 모델 레벨에서 막는다. 운영 migration의 전역 index가 더 강한 계약이다.
        UniqueConstraint(
            "account_id", "contact", "channel", name="uq_msg_suppression_scope"
        ),
        Index("idx_msg_suppress_contact", "contact"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)  # NULL=전역
    contact: Mapped[str] = mapped_column(Text, nullable=False)
    channel: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str] = mapped_column(String(20), nullable=False, default="unsubscribe")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 7) 리마인더 발송 원장 (go 191/195). (event, attendee, type, date) 멱등.
# ─────────────────────────────────────────────────────────────────────────────
REMINDER_TYPES = ("D7", "D1", "CHECKIN")


class ReminderSend(Base):
    """리마인더 발송 원장. (event_id, attendee_id, reminder_type, occurrence_date) 유일.

    선claim(INSERT ON CONFLICT DO NOTHING) 성공 건만 발송 → 중복 발송 방지.
    sent_at NULL 이고 30분 경과면 다음 cron 이 삭제 후 재시도.
    """

    __tablename__ = "reminder_sends"
    __table_args__ = (
        CheckConstraint(
            "reminder_type IN ('D7','D1','CHECKIN')", name="ck_reminder_sends_type"
        ),
        UniqueConstraint(
            "event_id",
            "attendee_id",
            "reminder_type",
            "occurrence_date",
            name="uq_reminder_sends_idem",
        ),
        Index("idx_reminder_sends_event", "event_id", "occurrence_date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    attendee_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    reminder_type: Mapped[str] = mapped_column(String(20), nullable=False)
    occurrence_date: Mapped[date] = mapped_column(Date, nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 8) 조직자 웹훅 (go 053 webhooks/webhook_logs).
#    v2 inter_service_webhook_deliveries 와 이름 충돌 회피 → organizer_ prefix.
# ─────────────────────────────────────────────────────────────────────────────
class OrganizerWebhook(Base):
    """조직자 아웃바운드 웹훅 등록(주최자→외부 endpoint). go webhooks 흡수."""

    __tablename__ = "organizer_webhooks"
    __table_args__ = (
        Index("idx_organizer_webhooks_account", "account_id"),
        Index("idx_organizer_webhooks_event", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    event_id: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    endpoint_url: Mapped[str] = mapped_column(Text, nullable=False)
    signing_secret: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    subscribed_events: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


class OrganizerWebhookLog(Base):
    """조직자 웹훅 배송 로그(HMAC 서명 배송 시도·응답). go webhook_logs 흡수."""

    __tablename__ = "organizer_webhook_logs"
    __table_args__ = (Index("idx_organizer_webhook_logs_webhook", "webhook_id"),)

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    webhook_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE,
        ForeignKey("organizer_webhooks.id", ondelete="CASCADE"),
        nullable=False,
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    response_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 9) 이메일 캠페인 (go 094/183/190/199/200) — W5-MSG 흡수.
#
# ⚠️ 폐기하지 않는다. go 220 은 캠페인을 event_messages 로 "수렴"시켰지만 그건 **발송 경로**
#    통합이고, 캠페인 원본(초안·세그먼트·수신자 스냅샷·오픈/클릭 통계)은 주최자 화면에서
#    여전히 조회된다. 원장을 v2 로 옮기되 테이블 정체성은 보존한다(대표 결정 2026-07-27).
#
# 신규 캠페인 생성은 go route 에서 이미 410(메시지로 수렴). 남은 라이프사이클 =
# 조회(list/stats) + 기존 draft 발송(→ v2 광고성 EventMessage 큐잉) + 트래킹 반영.
# ─────────────────────────────────────────────────────────────────────────────
EMAIL_CAMPAIGN_STATUSES = (
    "draft",
    "scheduled",
    "sending",
    "sent",
    "sent_with_failures",
    "failed",
    "cancelled",
)
EMAIL_CAMPAIGN_RECIPIENT_STATUSES = (
    "pending",
    "sending",
    "sent",
    "delivered",
    "failed",
    "skipped",
    "unknown",
)


class EmailCampaign(Base):
    """이메일 캠페인 헤더 — account/event 스코프. go email_campaigns 흡수.

    stats: {sent, opened, clicked, bounced, failed, skipped, total} 요약 캐시(실측 재계산).
    claim_token/claim_expires_at: go 199 실행 소유권 lease(이관 후에도 계약 보존).
    """

    __tablename__ = "email_campaigns"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft','scheduled','sending','sent','sent_with_failures',"
            "'failed','cancelled')",
            name="ck_email_campaigns_status",
        ),
        CheckConstraint(
            "message_type IN ('informational','advertising')",
            name="ck_email_campaigns_message_type",
        ),
        Index("idx_email_campaigns_account", "account_id"),
        Index("idx_email_campaigns_event", "event_id"),
        Index("idx_email_campaigns_status", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    # 흡수 원장 규약 — bare UUID(go account/event 원본 키). 크로스테넌트 경계 = account_id.
    account_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    event_id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, nullable=False)
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    body_html: Mapped[str] = mapped_column(Text, nullable=False)
    body_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    segment: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="draft")
    message_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="advertising"
    )
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stats: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    claim_token: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    claim_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


class EmailCampaignRecipient(Base):
    """캠페인 수신자 스냅샷 + 개별 상태/오픈/클릭. go email_campaign_recipients 흡수.

    (campaign_id, email) 유일 — go 190 이 중복 수신자 발송을 막던 계약을 그대로 승계한다.
    (go 190 은 lower(email) 유니크였고, 그 lower() 표현식 인덱스는 alembic 에서 재현한다.)
    """

    __tablename__ = "email_campaign_recipients"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','sending','sent','delivered','failed','skipped','unknown')",
            name="ck_email_campaign_recipients_status",
        ),
        UniqueConstraint("campaign_id", "email", name="uq_email_campaign_recipient"),
        Index("idx_ecr_campaign", "campaign_id"),
        Index("idx_ecr_email", "email"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE,
        ForeignKey("email_campaigns.id", ondelete="CASCADE"),
        nullable=False,
    )
    email: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    clicked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claim_token: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    claim_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 10) 인바운드 이메일 수신함 (go 098/208) — W5-MSG 흡수.
#
# 🔴 테넌트 경계 주의: go 원본에는 account_id 가 **없었고**, event 소유검증이 유일한 경계였다.
#    v2 이관에서 account_id 를 가산한다(webhook 이 참석자 매칭으로 알아낸 경우 채움). 조회
#    엔드포인트는 event_id 일치 + (account_id 가 있으면 반드시 일치)를 함께 요구한다 —
#    "account_id NULL 이면 통과"는 옛 계약과 정확히 동등하고, 값이 있으면 더 강하다.
# ─────────────────────────────────────────────────────────────────────────────
INBOUND_EMAIL_STATUSES = ("new", "replied", "archived")


class InboundEmail(Base):
    """주최자 수신함 — 참석자/문의자가 보낸 인바운드 메일. go inbound_emails 흡수."""

    __tablename__ = "inbound_emails"
    __table_args__ = (
        CheckConstraint(
            "status IN ('new','replied','archived')", name="ck_inbound_emails_status"
        ),
        Index("idx_inbound_emails_event", "event_id"),
        Index("idx_inbound_emails_status", "status"),
        Index("idx_inbound_emails_account", "account_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    # NULL 가능: 발신자를 어떤 이벤트/계정으로도 매칭하지 못한 수신 메일(go 원본 동작 보존).
    account_id: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    event_id: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    from_email: Mapped[str] = mapped_column(Text, nullable=False)
    from_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_html: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="new")
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    ai_draft: Mapped[str | None] = mapped_column(Text, nullable=True)
    reply_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    replied_by: Mapped[uuid.UUID | None] = mapped_column(_UUID_TYPE, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )
