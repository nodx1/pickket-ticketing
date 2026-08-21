"""조직자 단체메시지/캠페인 발송 — go → v2 재배선 내부 API (레벨2 3.4a).

go(pickket.go)의 주최자 단체발송/캠페인 UI route 가 지금까지 go DB `event_messages`/
`email_campaigns` 에 쓰고 go cron 이 발송했다. 이 라우터는 그 발송 트리거를 v2 조직자
메시징 SoT(EventMessage 생성 + Celery dispatch_service 큐잉)로 흡수한다.

정본 매핑(go route → v2 endpoint):
  - POST events/[id]/messages (단체발송)          → POST /internal/events/{event_id}/messages
  - POST events/[id]/campaigns/[cid]/send (캠페인) → POST /internal/events/{event_id}/messages
                                                     (message_type='advertising')
  - POST events/[id]/messages/[mid]/resend         → POST /internal/messages/{message_id}/requeue
  - POST events/[id]/messages/test (본인 테스트)   → POST /internal/messages/test-send

⚠️ 원자 컷오버(이중발송 0): 이 라우터는 **EventMessage 를 생성해 status=queued/scheduled** 로만
   남긴다. 실제 발송은 Celery beat(app.tasks.messaging_dispatch.dispatch_messages/
   dispatch_campaigns)가 claim 후 드레인한다(2차 C2 등록분). go 측은 flag on 시 go DB write·
   go cron 발송을 동시 OFF 로 전환하므로 두 소유자가 겹치지 않는다.

provider 발송은 W5-PROVIDER 로 실배선됨(NCP). test-send 는 NCP 설정이 갖춰져야 sent 가 나오고,
미설정이면 502 PROVIDER_UNWIRED 로 명확히 실패한다(조용한 성공 위장 금지).

스코프(크로스테넌트 경계):
  - account_id·event_id 는 go 원본 UUID(EventMessage 흡수 원장 규약 — bare UUID).
    account_id 는 반드시 요청 본문의 go_account_id 를 그대로 저장(위장 차단은 HMAC 인증이 담당).
  - 인증: internal_commerce 와 동일한 _internal_auth(HMAC/전환기 토큰) 재사용.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from app.api.v1.internal_commerce import (
    ApiError,
    _err,
    _idempotent,
    _internal_auth,
    _ok,
)
from app.core.config import settings
from app.core.database import get_db
from app.models.organizer_messaging import EventMessage
from app.services.messaging import compliance
from app.services.messaging.dispatch_service import (
    DispatchParams,
    default_sender,
    dispatch_one,
)

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(_internal_auth)])

# go event_messages.channel(email/sms/alimtalk) — push 는 조직자 발송 미지원(가산 확장점).
_CHANNELS = {"email", "sms", "alimtalk"}
_MESSAGE_TYPES = {"informational", "advertising"}
# go dispatch 내부 채널 정규화(compliance/dispatch 계약과 동일).
_TEST_CHANNEL_MAP = {"email": "email", "sms": "sms", "alimtalk": "kakao"}


def _enabled() -> bool:
    """원자 컷오버 게이트 — go 측 flag 와 동일 값. OFF 면 이 라우터는 409(미개시)."""
    return bool(getattr(settings, "ORGANIZER_MESSAGING_V2_ENABLED", False))


# ── 단체메시지/캠페인 생성 ───────────────────────────────────────────────────


class CreateMessageRequest(BaseModel):
    """go event_messages INSERT 를 v2 로 흡수 — 채널·유형은 go 가 서버강제한 값을 그대로 신뢰.

    go route 가 이미 deriveMessageType(§3-1) 로 message_type 을 서버강제하고 purpose→유형을
    result_meta 에 감사기록한다. v2 는 그 판정을 재실행하지 않고(단일 판정지점 유지) 저장만 한다.
    광고성 알림톡 금지 등 최종 게이트는 발송 시 dispatch_one 이 다시 검사한다(우회 불가).
    """

    go_account_id: uuid.UUID = Field(..., description="go account_id(조직자 스코프 키)")
    event_id: uuid.UUID = Field(..., description="go/v2 공유 event_id")
    title: str = Field(..., min_length=1)
    body: str = Field(..., min_length=1)
    channel: str = Field(..., description="email|sms|alimtalk")
    message_type: str = Field("informational", description="informational|advertising")
    recipient_filter: str = Field("all")
    segment: dict | None = None
    template_code: str | None = None
    scheduled_at: str | None = Field(None, description="ISO8601 — 미래면 scheduled")
    result_meta: dict | None = None


class CreateMessageResult(BaseModel):
    message_id: str
    status: str
    scheduled: bool


@router.post("/events/{event_id}/messages", summary="go: 단체메시지/캠페인 생성(v2 큐잉)")
async def create_message(
    event_id: uuid.UUID,
    body: CreateMessageRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    if not _enabled():
        return _err(
            ApiError(
                "MESSAGING_V2_DISABLED",
                "organizer messaging v2 is not enabled (ORGANIZER_MESSAGING_V2_ENABLED)",
                409,
            )
        )

    async def _producer() -> dict:
        if body.channel not in _CHANNELS:
            raise ApiError("VALIDATION_ERROR", f"unsupported channel: {body.channel}", 400, "channel")
        if body.message_type not in _MESSAGE_TYPES:
            raise ApiError(
                "VALIDATION_ERROR", f"invalid message_type: {body.message_type}", 400, "message_type"
            )
        # path event_id 와 body.event_id 는 반드시 일치(경계 교차 write 차단).
        if body.event_id != event_id:
            raise ApiError("VALIDATION_ERROR", "event_id mismatch (path vs body)", 400, "event_id")

        # scheduled_at 이 미래면 scheduled(Celery 가 시각 도달 시 드레인), 아니면 queued(즉시).
        scheduled_dt = None
        if body.scheduled_at:
            from app.api.v1.internal_sync import _parse_iso

            try:
                scheduled_dt = _parse_iso(body.scheduled_at)
            except Exception as exc:  # noqa: BLE001
                raise ApiError("VALIDATION_ERROR", "invalid scheduled_at", 400, "scheduled_at") from exc
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        future = scheduled_dt is not None and scheduled_dt > now
        status = "scheduled" if future else "queued"

        msg = EventMessage(
            id=uuid.uuid4(),
            account_id=body.go_account_id,
            event_id=event_id,
            title=body.title,
            channel=body.channel,
            message_type=body.message_type,
            status=status,
            body=body.body,
            recipient_filter=body.recipient_filter,
            segment=body.segment,
            template_code=body.template_code if body.channel == "alimtalk" else None,
            scheduled_at=scheduled_dt if future else None,
            result_meta=body.result_meta,
        )
        db.add(msg)
        await db.commit()
        logger.info(
            "organizer message queued(v2): message=%s event=%s channel=%s type=%s status=%s",
            msg.id, event_id, body.channel, body.message_type, status,
        )
        return CreateMessageResult(
            message_id=str(msg.id), status=status, scheduled=future
        ).model_dump()

    try:
        result = await _idempotent(
            idempotency_key, "create_message", _producer, fingerprint=body
        )
        return result
    except ApiError as e:
        return _err(e)


# ── 재발송(requeue) ──────────────────────────────────────────────────────────


class RequeueRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID


@router.post("/messages/{message_id}/requeue", summary="go: 메시지 재발송 요청(v2 재큐잉)")
async def requeue_message(
    message_id: uuid.UUID,
    body: RequeueRequest,
    db: AsyncSession = Depends(get_db),
):
    """sent/sent_with_failures/failed → queued 로 되돌린다. 이미 발송된 수신자는 원장 멱등으로 스킵.

    account_id·event_id 경계 검증(크로스테넌트 차단). Celery dispatch 가 실패/미처리만 재시도.
    """
    if not _enabled():
        return _err(ApiError("MESSAGING_V2_DISABLED", "messaging v2 disabled", 409))
    msg = (
        await db.execute(
            select(EventMessage).where(
                EventMessage.id == message_id,
                EventMessage.account_id == body.go_account_id,
                EventMessage.event_id == body.event_id,
            )
        )
    ).scalar_one_or_none()
    if msg is None:
        return _err(ApiError("MESSAGE_NOT_FOUND", "message not found in scope", 404))
    if msg.status not in ("sent", "sent_with_failures", "failed"):
        return _err(ApiError("INVALID_STATE", "message is not requeue-able", 400))
    from datetime import datetime, timezone

    msg.status = "queued"
    msg.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return _ok({"message_id": str(message_id), "status": "queued"})


# ── 본인 테스트 발송(단발, 원장 미기록) ──────────────────────────────────────


class TestSendRequest(BaseModel):
    go_account_id: uuid.UUID
    channel: str = Field(..., description="email|sms|alimtalk")
    to: str = Field(..., min_length=1)
    title: str = Field("", description="이메일 subject")
    body: str = Field(..., min_length=1)
    message_type: str = Field("informational")
    template_code: str | None = None


@router.post("/messages/test-send", summary="go: 본인 테스트 발송(단발 dispatch)")
async def test_send(
    body: TestSendRequest,
    db: AsyncSession = Depends(get_db),
):
    """작성 중 메시지를 담당자 본인에게 1건 발송(go messages/test 포팅).

    원장 미기록(record_ledger=False) — message_id 없는 단발. NCP 미설정(미배선 스텁)이면
    NotImplemented → status='unknown'/에러가 아니라 명시적 미배선 신호로 502 반환
    (조용한 성공 위장 금지). 배선 확인용 운영 스모크 경로이기도 하다.
    """
    if not _enabled():
        return _err(ApiError("MESSAGING_V2_DISABLED", "messaging v2 disabled", 409))
    ch = _TEST_CHANNEL_MAP.get(body.channel)
    if ch is None:
        return _err(ApiError("VALIDATION_ERROR", f"unsupported channel: {body.channel}", 400, "channel"))
    mt = "advertising" if body.message_type == "advertising" else "informational"
    params = DispatchParams(
        account_id=str(body.go_account_id),
        channel=ch,
        message_type=mt,
        to=body.to,
        body=body.body,
        subject=body.title or None,
        template_code=body.template_code,
    )
    # ⚠️ record_ledger=False 라 원장에 흔적이 남지 않는 유일한 실발송 경로다(수신자를 요청자가
    #    자유 지정). 최소 감사 흔적을 남긴다 — 연락처는 마스킹(전체 연락처 로깅 금지).
    #    남은 리스크(레이트리밋·수신자 화이트리스트 부재)는 배선 보고서에 후속으로 기록.
    from app.services.messaging.providers.ncp_client import mask_contact

    logger.info(
        "test-send 요청: account=%s channel=%s to=%s template=%s",
        body.go_account_id,
        ch,
        mask_contact(body.to),
        body.template_code or "-",
    )
    try:
        result = await dispatch_one(
            db, params, sender=default_sender(), record_ledger=False
        )
    except NotImplementedError:
        # NCP 자격증명 미설정 — 실발송 불가. 성공으로 위장하지 않고 명시적 502.
        return _err(
            ApiError(
                "PROVIDER_UNWIRED",
                "발송 provider 미배선(NCP 자격증명·발신설정 미완)으로 발송할 수 없습니다",
                502,
            )
        )
    if result.status == "sent":
        return _ok({"status": "sent", "request_id": result.request_id})
    if result.status == "skipped":
        return _err(ApiError("SEND_SKIPPED", f"발송 게이트에서 제외됨: {result.reason}", 422))
    return _err(ApiError("SEND_FAILED", f"발송 실패: {result.error or result.reason}", 502))


# ─────────────────────────────────────────────────────────────────────────────
# W3-MSG: 컴플라이언스 원장(수신거부·수신동의) — go DB 이탈용 내부 API.
#
# ⚠️ 위쪽 발송 트리거와 달리 이 구간은 **_enabled() 게이트를 걸지 않는다.**
#   ORGANIZER_MESSAGING_V2_ENABLED 는 "발송 소유권"(go cron vs v2 Celery)의 배타 스위치다.
#   반면 억제/동의 원장은 **누가 발송하든 단일 정본**이어야 한다. 여기에 flag 를 걸면
#   flag OFF 구간에서 go 가 409 를 받아 수신거부 판정을 못 하고, 그 실패를 "억제 없음"으로
#   흘리면 **수신거부자에게 발송**된다. 소유권과 원장은 분리한다.
#
# go 대응부: organizer/src/lib/v2/messaging-compliance-client.ts
#            → organizer/src/lib/notification/{compliance,recipients}.ts
# ─────────────────────────────────────────────────────────────────────────────

_COMPLIANCE_CHANNELS = {"email", "sms", "kakao"}
_SUPPRESSION_CHANNELS = _COMPLIANCE_CHANNELS | {"all"}
_SUPPRESSION_REASONS = {"unsubscribe", "bounce", "complaint", "manual"}
# 한 번에 판정 가능한 연락처 수 상한(go 세그먼트 발송 배치 크기와 동일 계약).
_MAX_CONTACTS = 5000


class SuppressionFilterRequest(BaseModel):
    """세그먼트 수신자 배치 억제 판정 — go recipients.ts 가 발송 직전 호출."""

    go_account_id: uuid.UUID
    channel: str = Field(..., description="email|sms|kakao")
    contacts: list[str] = Field(default_factory=list)
    undeliverable_only: bool = Field(
        False, description="True 면 bounce/complaint 만(정보성 게이트)"
    )


@router.post("/messaging/suppressions/filter", summary="go: 억제 배치 판정")
async def filter_suppressions(
    body: SuppressionFilterRequest,
    db: AsyncSession = Depends(get_db),
):
    if body.channel not in _COMPLIANCE_CHANNELS:
        return _err(
            ApiError("VALIDATION_ERROR", f"unsupported channel: {body.channel}", 400, "channel")
        )
    if len(body.contacts) > _MAX_CONTACTS:
        return _err(
            ApiError(
                "VALIDATION_ERROR",
                f"too many contacts (max {_MAX_CONTACTS})",
                400,
                "contacts",
            )
        )
    suppressed = await compliance.filter_suppressed(
        db,
        body.go_account_id,
        body.channel,  # type: ignore[arg-type]
        body.contacts,
        undeliverable_only=body.undeliverable_only,
    )
    return _ok({"suppressed": sorted(suppressed)})


class SuppressionUpsertRequest(BaseModel):
    """수신거부/바운스 억제 등록. go_account_id 미지정(null) = 전역 억제."""

    go_account_id: uuid.UUID | None = None
    channel: str = Field(..., description="email|sms|kakao|all")
    contact: str = Field(..., min_length=1)
    reason: str = Field("unsubscribe", description="unsubscribe|bounce|complaint|manual")


@router.post("/messaging/suppressions", summary="go: 억제 등록(수신거부·바운스)")
async def upsert_suppression(
    body: SuppressionUpsertRequest,
    db: AsyncSession = Depends(get_db),
):
    if body.channel not in _SUPPRESSION_CHANNELS:
        return _err(
            ApiError("VALIDATION_ERROR", f"unsupported channel: {body.channel}", 400, "channel")
        )
    if body.reason not in _SUPPRESSION_REASONS:
        return _err(
            ApiError("VALIDATION_ERROR", f"invalid reason: {body.reason}", 400, "reason")
        )
    await compliance.suppress(
        db,
        body.go_account_id,
        body.channel,  # type: ignore[arg-type]
        body.contact,
        body.reason,  # type: ignore[arg-type]
    )
    await db.commit()
    return _ok({"suppressed": True})


class ConsentFilterRequest(BaseModel):
    go_account_id: uuid.UUID
    channel: str = Field(..., description="email|sms|kakao")
    contacts: list[str] = Field(default_factory=list)


@router.post("/messaging/consents/filter", summary="go: 수신동의 배치 조회")
async def filter_consents(
    body: ConsentFilterRequest,
    db: AsyncSession = Depends(get_db),
):
    if body.channel not in _COMPLIANCE_CHANNELS:
        return _err(
            ApiError("VALIDATION_ERROR", f"unsupported channel: {body.channel}", 400, "channel")
        )
    if len(body.contacts) > _MAX_CONTACTS:
        return _err(
            ApiError(
                "VALIDATION_ERROR", f"too many contacts (max {_MAX_CONTACTS})", 400, "contacts"
            )
        )
    found = await compliance.fetch_consents(
        db,
        body.go_account_id,
        body.channel,  # type: ignore[arg-type]
        body.contacts,
    )
    # 행이 없는 연락처는 응답에 넣지 않는다 — 호출자가 "부재 = 미동의"로 읽는다.
    return _ok(
        {
            "consents": [
                {"contact": c, "consented": v[0], "night_consented": v[1]}
                for c, v in sorted(found.items())
            ]
        }
    )


class ConsentRecordRequest(BaseModel):
    """수신동의 취득/철회. action='grant'|'withdraw'."""

    go_account_id: uuid.UUID
    channel: str = Field(..., description="email|sms|kakao")
    contact: str = Field(..., min_length=1)
    action: str = Field("grant", description="grant|withdraw")
    consented: bool = True
    night_consented: bool = False
    source: str | None = None
    wording_version: str | None = None


@router.post("/messaging/consents", summary="go: 수신동의 취득/철회")
async def record_consent_endpoint(
    body: ConsentRecordRequest,
    db: AsyncSession = Depends(get_db),
):
    if body.channel not in _COMPLIANCE_CHANNELS:
        return _err(
            ApiError("VALIDATION_ERROR", f"unsupported channel: {body.channel}", 400, "channel")
        )
    if body.action not in ("grant", "withdraw"):
        return _err(
            ApiError("VALIDATION_ERROR", f"invalid action: {body.action}", 400, "action")
        )
    if body.action == "withdraw":
        await compliance.withdraw_consent(
            db,
            body.go_account_id,
            body.channel,  # type: ignore[arg-type]
            body.contact,
            body.source or "unsubscribe",
        )
    else:
        await compliance.record_consent(
            db,
            body.go_account_id,
            body.channel,  # type: ignore[arg-type]
            body.contact,
            consented=body.consented,
            night_consented=body.night_consented,
            source=body.source,
            wording_version=body.wording_version,
        )
    await db.commit()
    return _ok({"action": body.action})


# ═════════════════════════════════════════════════════════════════════════════
# W5-MSG: 발송 원장 본체 read/write API — go DB 이탈용 내부 API.
#
# W3-MSG 가 억제/동의 원장을 옮겼고, 여기서는 **발송 결과 원장(message_deliveries,
# attempts, operator actions)·메시지 조회·캠페인·수신함**을 마저 옮긴다.
#
# ⚠️ _enabled() 게이트를 걸지 않는다 — W3-MSG 컴플라이언스 구간과 같은 이유다.
#   ORGANIZER_MESSAGING_V2_ENABLED 는 **발송 소유권**(go cron vs v2 Celery)의 배타 스위치이지
#   원장 소유권 스위치가 아니다. 원장은 이미 v2 가 유일 정본이므로(go 마이그 250 이 원본
#   테이블을 DROP) 여기에 flag 를 걸면 flag OFF 구간에서 주최자 화면이 통째로 죽는다.
#
# 🔴 크로스테넌트: 모든 목록/집계는 go_account_id 를 WHERE 에 강제한다. 단 하나라도 빠지면
#   다른 주최자의 수신자 연락처가 노출된다(Critical).
#
# 🔴 fail-closed: 조회 실패를 빈 목록으로 흘리지 않는다. 예외는 그대로 전파되어 500/503 이
#   되고 go 는 그것을 사용자에게 알린다. "0건"과 "확인 불가"는 다른 사실이다.
#
# go 대응부: organizer/src/lib/v2/messaging-ledger-client.ts
# ═════════════════════════════════════════════════════════════════════════════

from datetime import datetime as _dt, timedelta as _td, timezone as _tz  # noqa: E402

from sqlalchemy import and_, func, or_, update  # noqa: E402

from app.models.organizer_messaging import (  # noqa: E402
    EmailCampaign,
    EmailCampaignRecipient,
    EventMessage as _EventMessage,
    InboundEmail,
    MessageDelivery,
    MessageDeliveryAttempt,
    MessageDeliveryOperatorAction,
)
from app.services.messaging.compliance import normalize_contact as _normalize_contact  # noqa: E402
from app.services.messaging.message_dispatch import (  # noqa: E402
    recompute_message_status as _recompute_message_status,
)

_DELIVERY_LIST_MAX = 5000
_OPERATOR_ACTIONS = {"manual_review", "confirm_sent", "confirm_failed", "resend", "reconcile"}
# unknown 대사 정책 — go dlr.ts UNKNOWN_MAX_* 와 동일 값(포팅).
_UNKNOWN_MAX_ATTEMPTS = 5
_UNKNOWN_MAX_AGE_MINUTES = 120


def _now_utc() -> _dt:
    return _dt.now(_tz.utc)


def _iso(value) -> str | None:
    return value.isoformat() if value is not None else None


def _mask_contact(channel: str, contact: str) -> str:
    """운영 화면 노출용 부분 마스킹 — 원장 원문은 API 밖으로 내보내지 않는다."""
    if not contact:
        return "[masked]"
    if channel == "email" and "@" in contact[1:]:
        at = contact.index("@")
        return f"{contact[0]}***{contact[at:]}"
    if channel in ("sms", "kakao"):
        return "*" * max(len(contact) - 4, 0) + contact[-4:]
    return "[masked]"


# ── A. 메시지 조회(주최자 화면) ───────────────────────────────────────────────


class MessageListRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    status: str | None = None


def _message_row(m: _EventMessage) -> dict:
    return {
        "id": str(m.id),
        "title": m.title,
        "channel": m.channel,
        "status": m.status,
        "body": m.body,
        "message_type": m.message_type,
        "recipient_filter": m.recipient_filter,
        "template_code": m.template_code,
        "sent_count": m.sent_count,
        "failed_count": m.failed_count,
        "delivered_count": m.delivered_count,
        "opened_count": m.opened_count,
        "clicked_count": m.clicked_count,
        "result_meta": m.result_meta,
        "scheduled_at": _iso(m.scheduled_at),
        "sent_at": _iso(m.sent_at),
        "created_at": _iso(m.created_at),
    }


@router.post("/messaging/messages/list", summary="go: 이벤트 단체메시지 목록")
async def list_event_messages(
    body: MessageListRequest,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(_EventMessage).where(
        _EventMessage.account_id == body.go_account_id,
        _EventMessage.event_id == body.event_id,
    )
    if body.status:
        stmt = stmt.where(_EventMessage.status == body.status)
    rows = (
        await db.execute(stmt.order_by(_EventMessage.created_at.desc()))
    ).scalars().all()
    return _ok({"messages": [_message_row(m) for m in rows]})


class MessageGetRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    message_id: uuid.UUID


@router.post("/messaging/messages/get", summary="go: 단체메시지 단건")
async def get_event_message(
    body: MessageGetRequest,
    db: AsyncSession = Depends(get_db),
):
    msg = (
        await db.execute(
            select(_EventMessage).where(
                _EventMessage.id == body.message_id,
                _EventMessage.account_id == body.go_account_id,
                _EventMessage.event_id == body.event_id,
            )
        )
    ).scalar_one_or_none()
    if msg is None:
        return _err(ApiError("MESSAGE_NOT_FOUND", "message not found in scope", 404))
    return _ok({"message": _message_row(msg)})


class MessageDeliveriesRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    message_id: uuid.UUID
    status: str | None = None
    limit: int = Field(100, ge=1, le=_DELIVERY_LIST_MAX)
    offset: int = Field(0, ge=0)


@router.post("/messaging/messages/deliveries", summary="go: 메시지 수신자별 발송 상세")
async def list_message_deliveries(
    body: MessageDeliveriesRequest,
    db: AsyncSession = Depends(get_db),
):
    """수신자별 도달/오픈/클릭/실패 사유 + 전체 집계.

    🔴 소유 검증을 **여기서** 한다 — go 가 별도로 확인하고 오는 것에 기대지 않는다.
       (message_id 만으로 조회하면 다른 계정의 수신자 목록이 그대로 나간다.)
    """
    owns = (
        await db.execute(
            select(_EventMessage.id).where(
                _EventMessage.id == body.message_id,
                _EventMessage.account_id == body.go_account_id,
                _EventMessage.event_id == body.event_id,
            )
        )
    ).scalar_one_or_none()
    if owns is None:
        return _err(ApiError("MESSAGE_NOT_FOUND", "message not found in scope", 404))

    base = and_(
        MessageDelivery.message_id == body.message_id,
        MessageDelivery.account_id == body.go_account_id,
    )
    stmt = select(MessageDelivery).where(base)
    if body.status:
        stmt = stmt.where(MessageDelivery.status == body.status)
    rows = (
        await db.execute(
            stmt.order_by(MessageDelivery.updated_at.desc())
            .limit(body.limit)
            .offset(body.offset)
        )
    ).scalars().all()

    agg = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(MessageDelivery.status.in_(("sent", "delivered"))),
                func.count().filter(MessageDelivery.status == "delivered"),
                func.count().filter(MessageDelivery.status == "failed"),
                func.count().filter(MessageDelivery.status == "skipped"),
                func.count().filter(MessageDelivery.opened_at.isnot(None)),
                func.count().filter(MessageDelivery.clicked_at.isnot(None)),
            ).where(base)
        )
    ).one()
    total, sent, delivered, failed, skipped, opened, clicked = (int(x or 0) for x in agg)

    return _ok(
        {
            "items": [
                {
                    # 원문 연락처는 내보내지 않는다(운영 화면도 마스킹 표시가 계약).
                    "contact_masked": _mask_contact(d.channel, d.contact),
                    "status": d.status,
                    "reason": d.reason,
                    "channel": d.channel,
                    "delivered_at": _iso(d.delivered_at),
                    "opened_at": _iso(d.opened_at),
                    "clicked_at": _iso(d.clicked_at),
                    "updated_at": _iso(d.updated_at),
                }
                for d in rows
            ],
            "total": total,
            "summary": {
                "total": total,
                "sent": sent,
                "delivered": delivered,
                "failed": failed,
                "skipped": skipped,
                "opened": opened,
                "clicked": clicked,
            },
        }
    )


# ── B. 발송 건 운영(owner) ────────────────────────────────────────────────────


class DeliveryQueueRequest(BaseModel):
    go_account_id: uuid.UUID
    status: str = "unknown"
    limit: int = Field(50, ge=1, le=100)


_QUEUE_STATUSES = {"unknown", "manual_review", "failed", "sent", "delivered"}


@router.post("/messaging/deliveries/queue", summary="go: 미확정 발송 큐(owner)")
async def list_delivery_queue(
    body: DeliveryQueueRequest,
    db: AsyncSession = Depends(get_db),
):
    status = body.status if body.status in _QUEUE_STATUSES else "unknown"
    rows = (
        await db.execute(
            select(MessageDelivery, _EventMessage.event_id, _EventMessage.title)
            .join(
                _EventMessage,
                and_(
                    _EventMessage.id == MessageDelivery.message_id,
                    _EventMessage.account_id == MessageDelivery.account_id,
                ),
            )
            .where(
                MessageDelivery.account_id == body.go_account_id,
                MessageDelivery.status == status,
            )
            .order_by(MessageDelivery.created_at.asc())
            .limit(body.limit)
        )
    ).all()
    return _ok(
        {
            "items": [
                {
                    "id": str(d.id),
                    "message_id": str(d.message_id),
                    "channel": d.channel,
                    "status": d.status,
                    "reason": d.reason,
                    "request_id": d.request_id,
                    "reconcile_attempts": d.reconcile_attempts,
                    "created_at": _iso(d.created_at),
                    "updated_at": _iso(d.updated_at),
                    "event_id": str(event_id),
                    "title": title,
                    "contact_masked": _mask_contact(d.channel, d.contact),
                }
                for d, event_id, title in rows
            ]
        }
    )


class DeliveryGetRequest(BaseModel):
    go_account_id: uuid.UUID
    delivery_id: uuid.UUID


@router.post("/messaging/deliveries/get", summary="go: 발송 건 상세 + attempt 이력(owner)")
async def get_delivery(
    body: DeliveryGetRequest,
    db: AsyncSession = Depends(get_db),
):
    row = (
        await db.execute(
            select(MessageDelivery, _EventMessage.event_id, _EventMessage.title, _EventMessage.status)
            .join(
                _EventMessage,
                and_(
                    _EventMessage.id == MessageDelivery.message_id,
                    _EventMessage.account_id == MessageDelivery.account_id,
                ),
            )
            .where(
                MessageDelivery.id == body.delivery_id,
                MessageDelivery.account_id == body.go_account_id,
            )
        )
    ).first()
    if row is None:
        return _err(ApiError("DELIVERY_NOT_FOUND", "delivery not found in scope", 404))
    d, event_id, title, message_status = row
    attempts = (
        await db.execute(
            select(MessageDeliveryAttempt)
            .where(MessageDeliveryAttempt.delivery_id == d.id)
            .order_by(MessageDeliveryAttempt.attempt_no.asc())
        )
    ).scalars().all()
    return _ok(
        {
            "delivery": {
                "id": str(d.id),
                "message_id": str(d.message_id),
                "channel": d.channel,
                "status": d.status,
                "reason": d.reason,
                "request_id": d.request_id,
                "reconcile_attempts": d.reconcile_attempts,
                "reconcile_first_at": _iso(d.reconcile_first_at),
                "last_reconciled_at": _iso(d.last_reconciled_at),
                "next_reconcile_at": _iso(d.next_reconcile_at),
                "created_at": _iso(d.created_at),
                "updated_at": _iso(d.updated_at),
                "event_id": str(event_id),
                "title": title,
                "message_status": message_status,
                "contact_masked": _mask_contact(d.channel, d.contact),
            },
            "attempts": [
                {
                    "id": str(a.id),
                    "attempt_no": a.attempt_no,
                    "provider": a.provider,
                    "idempotency_key": a.idempotency_key,
                    "provider_request_id": a.provider_request_id,
                    "http_status": a.http_status,
                    "result_status": a.result_status,
                    "timeout_stage": a.timeout_stage,
                    "ambiguous": a.ambiguous,
                    "started_at": _iso(a.started_at),
                    "finished_at": _iso(a.finished_at),
                    "provider_error_code": a.provider_error_code,
                    "provider_error_summary": a.provider_error_summary,
                }
                for a in attempts
            ],
        }
    )


class OperatorActionRequest(BaseModel):
    go_account_id: uuid.UUID
    actor_id: uuid.UUID
    delivery_id: uuid.UUID
    operation_key: str = Field(..., min_length=1, max_length=200)
    action: str
    reason: str = Field(..., min_length=5, max_length=1000)
    provider_request_id: str | None = None


def _action_allowed(action: str, status: str) -> bool:
    if action in ("manual_review", "reconcile", "confirm_sent", "confirm_failed"):
        return status in ("unknown", "manual_review")
    if action == "resend":
        # unknown 은 provider 결과를 먼저 확정해야 한다 — failed 확정 후에만 재발송.
        return status == "failed"
    return False


@router.post("/messaging/deliveries/operator-action", summary="go: 발송 건 복구 액션(owner)")
async def delivery_operator_action(
    body: OperatorActionRequest,
    db: AsyncSession = Depends(get_db),
):
    """소유자 전용 복구 액션. (account_id, operation_key) 유니크로 재시도 멱등.

    멱등 계약: 같은 operation_key 재요청은 최초 결과를 그대로 재생한다. **불안정한 키
    (매 호출 randomUUID)를 보내면 멱등이 아니다** — go 는 클라이언트가 준 Idempotency-Key
    를 그대로 전달한다.

    트랜잭션 경계: 원장 기록 → 상태 전이 → 부모 재계산이 한 트랜잭션. 외부호출 없음.
    """
    if body.action not in _OPERATOR_ACTIONS:
        return _err(ApiError("VALIDATION_ERROR", f"invalid action: {body.action}", 400, "action"))

    d = (
        await db.execute(
            select(MessageDelivery)
            .where(
                MessageDelivery.id == body.delivery_id,
                MessageDelivery.account_id == body.go_account_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if d is None:
        return _err(ApiError("DELIVERY_NOT_FOUND", "delivery not found in scope", 404))

    prior = (
        await db.execute(
            select(MessageDeliveryOperatorAction).where(
                MessageDeliveryOperatorAction.account_id == body.go_account_id,
                MessageDeliveryOperatorAction.operation_key == body.operation_key,
            )
        )
    ).scalar_one_or_none()
    if prior is not None:
        # 다른 delivery/action 에 같은 키를 재사용하면 옛 응답을 재생하지 않고 409.
        if prior.delivery_id != body.delivery_id or prior.action != body.action:
            return _err(
                ApiError("IDEMPOTENCY_KEY_REUSED", "operation key used for another action", 409)
            )
        return _ok({**(prior.result or {}), "idempotent": True})

    if not _action_allowed(body.action, d.status):
        return _err(ApiError("INVALID_STATE", "action not allowed in current status", 409))
    if body.action == "confirm_sent" and not body.provider_request_id:
        return _err(
            ApiError("VALIDATION_ERROR", "confirm_sent requires provider_request_id", 400)
        )

    now = _now_utc()
    from_status = d.status
    target_status = {
        "confirm_sent": "sent",
        "confirm_failed": "failed",
        "manual_review": "manual_review",
    }.get(body.action, from_status)

    record = MessageDeliveryOperatorAction(
        delivery_id=d.id,
        account_id=body.go_account_id,
        actor_id=body.actor_id,
        operation_key=body.operation_key,
        action=body.action,
        from_status=from_status,
        to_status=target_status,
        reason=body.reason,
        provider_request_id=body.provider_request_id,
        created_at=now,
    )
    db.add(record)
    await db.flush()

    if body.action == "reconcile":
        d.next_reconcile_at = now
        d.reason = f"operator_requested:{body.reason}"
        d.updated_at = now
    elif body.action == "resend":
        unresolved = (
            await db.execute(
                select(func.count()).select_from(MessageDelivery).where(
                    MessageDelivery.message_id == d.message_id,
                    MessageDelivery.status.in_(("unknown", "manual_review")),
                )
            )
        ).scalar_one()
        if int(unresolved or 0) > 0:
            await db.rollback()
            return _err(
                ApiError("INVALID_STATE", "unresolved deliveries block resend", 409)
            )
        await db.execute(
            update(_EventMessage)
            .where(
                _EventMessage.id == d.message_id,
                _EventMessage.account_id == body.go_account_id,
            )
            .values(status="queued", updated_at=now)
        )
    else:
        d.status = target_status
        if body.provider_request_id:
            d.request_id = body.provider_request_id
        d.claim_token = None
        d.claim_expires_at = None
        d.updated_at = now
        latest = (
            await db.execute(
                select(MessageDeliveryAttempt)
                .where(MessageDeliveryAttempt.delivery_id == d.id)
                .order_by(MessageDeliveryAttempt.attempt_no.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if latest is not None and latest.result_status in ("inflight", "unknown"):
            latest.result_status = target_status
            latest.finished_at = latest.finished_at or now
            latest.provider_request_id = latest.provider_request_id or body.provider_request_id
            if target_status == "failed":
                latest.provider_error_summary = body.reason
            latest.updated_at = now

    await db.flush()
    message_id = d.message_id
    result = {
        "delivery_id": str(body.delivery_id),
        "action": body.action,
        "previous_status": from_status,
        "status": target_status,
        "requeued": body.action == "resend",
    }
    record.result = result
    await db.commit()

    # 부모 상태 재계산(자체 commit). resend 는 재계산이 failed 원장을 보고
    # sent_with_failures 로 되돌리므로 재계산 뒤 다시 queued 로 고정한다.
    aggregate = await _recompute_message_status(db, message_id)
    if body.action == "resend":
        await db.execute(
            update(_EventMessage)
            .where(
                _EventMessage.id == message_id,
                _EventMessage.account_id == body.go_account_id,
            )
            .values(status="queued", updated_at=_now_utc())
        )
        await db.commit()
        result["parent_status"] = "queued"
    else:
        result["parent_status"] = aggregate
    return _ok(result)


class RecoverySummaryRequest(BaseModel):
    go_account_id: uuid.UUID


@router.post("/messaging/deliveries/recovery-summary", summary="go: 발송 복구 큐 요약(owner)")
async def delivery_recovery_summary(
    body: RecoverySummaryRequest,
    db: AsyncSession = Depends(get_db),
):
    now = _now_utc()
    stuck_cutoff = now - _td(minutes=10)
    row = (
        await db.execute(
            select(
                func.count().filter(MessageDelivery.status.in_(("sending", "queued"))),
                func.count().filter(MessageDelivery.status == "unknown"),
                func.count().filter(MessageDelivery.status == "manual_review"),
                func.count().filter(MessageDelivery.status == "failed"),
                func.min(MessageDelivery.updated_at).filter(
                    MessageDelivery.status == "unknown"
                ),
                func.count().filter(
                    and_(
                        _EventMessage.status == "sending",
                        _EventMessage.updated_at < stuck_cutoff,
                    )
                ),
            )
            .select_from(MessageDelivery)
            .join(
                _EventMessage,
                and_(
                    _EventMessage.id == MessageDelivery.message_id,
                    _EventMessage.account_id == MessageDelivery.account_id,
                ),
            )
            .where(MessageDelivery.account_id == body.go_account_id)
        )
    ).one()
    inflight, unknown, manual_review, failed, oldest_unknown, parent_stuck = row
    age = 0
    if oldest_unknown is not None:
        ref = oldest_unknown
        if ref.tzinfo is None:
            ref = ref.replace(tzinfo=_tz.utc)
        age = int((now - ref).total_seconds())
    return _ok(
        {
            "inflight": int(inflight or 0),
            "unknown": int(unknown or 0),
            "manual_review": int(manual_review or 0),
            "failed": int(failed or 0),
            "oldest_unknown_age_seconds": age,
            "parent_stuck": int(parent_stuck or 0),
        }
    )


class MessagingMetricsRequest(BaseModel):
    """Prometheus 노출용 전역 집계 — account 스코프 없음(운영자 전용 /api/metrics)."""

    stale_minutes: int = Field(15, ge=1, le=1440)


@router.post("/messaging/metrics", summary="go: 발송 원장 전역 메트릭")
async def messaging_metrics(
    body: MessagingMetricsRequest,
    db: AsyncSession = Depends(get_db),
):
    now = _now_utc()
    rows = (
        await db.execute(
            select(
                MessageDelivery.status,
                func.count(),
                func.min(MessageDelivery.created_at),
            )
            .where(
                MessageDelivery.status.in_(
                    ("sending", "unknown", "manual_review", "failed")
                )
            )
            .group_by(MessageDelivery.status)
        )
    ).all()
    queues = []
    for status, count, oldest in rows:
        age = None
        if oldest is not None:
            ref = oldest if oldest.tzinfo else oldest.replace(tzinfo=_tz.utc)
            age = int((now - ref).total_seconds())
        queues.append({"status": status, "count": int(count or 0), "oldest_age_seconds": age})

    stale_cutoff = now - _td(minutes=body.stale_minutes)
    stale = (
        await db.execute(
            select(func.count(), func.min(MessageDelivery.updated_at)).where(
                MessageDelivery.status == "sending",
                MessageDelivery.updated_at < stale_cutoff,
            )
        )
    ).one()
    if int(stale[0] or 0) > 0:
        ref = stale[1]
        if ref is not None and ref.tzinfo is None:
            ref = ref.replace(tzinfo=_tz.utc)
        queues.append(
            {
                "status": "stale_inflight",
                "count": int(stale[0]),
                "oldest_age_seconds": int((now - ref).total_seconds()) if ref else None,
            }
        )

    err_cutoff = now - _td(hours=24)
    err_rows = (
        await db.execute(
            select(
                func.count().filter(MessageDeliveryAttempt.http_status == 429),
                func.count().filter(MessageDeliveryAttempt.http_status >= 500),
            ).where(MessageDeliveryAttempt.created_at > err_cutoff)
        )
    ).one()
    provider_errors = []
    if int(err_rows[0] or 0):
        provider_errors.append({"error_class": "429", "count": int(err_rows[0])})
    if int(err_rows[1] or 0):
        provider_errors.append({"error_class": "5xx", "count": int(err_rows[1])})
    return _ok({"queues": queues, "provider_errors": provider_errors})


# ── C. DLR(도달결과) 대사 브리지 ──────────────────────────────────────────────
#
# ⚠️ 왜 브리지인가: provider 상태조회 API(NCP SENS/Cloud Outbound Mailer) 클라이언트는
#    go 에만 있고 v2 celery `reconcile_deliveries` 는 "DLR 은 알림톡 세션 소유부"라며
#    **하지 않는다**. 그대로 go 를 스텁화하면 sent→delivered 정정 경로가 끊겨 발송이
#    영원히 "발송중"으로 남는다(원장은 v2 인데 정정하는 사람이 없음).
#    → 원장 read/write 는 v2 가, provider 조회만 go 가 한다. 이중발송과 무관하다
#      (v2 celery 는 status='sending' lease 만료만 손대고, 여기는 'sent'/'unknown' 만 손댄다).


class DlrPendingRequest(BaseModel):
    limit: int = Field(50, ge=1, le=500)


@router.post("/messaging/deliveries/dlr/pending", summary="go: DLR 대사 대상 requestId")
async def dlr_pending(
    body: DlrPendingRequest,
    db: AsyncSession = Depends(get_db),
):
    """접수(sent)됐지만 미도달인 SMS/알림톡 requestId — 2분 경과 ~ 2일 이내."""
    now = _now_utc()
    rows = (
        await db.execute(
            select(MessageDelivery.request_id, MessageDelivery.channel)
            .where(
                MessageDelivery.channel.in_(("sms", "kakao")),
                MessageDelivery.status == "sent",
                MessageDelivery.delivered_at.is_(None),
                MessageDelivery.request_id.isnot(None),
                MessageDelivery.request_id != "",
                MessageDelivery.created_at < now - _td(minutes=2),
                MessageDelivery.created_at > now - _td(days=2),
            )
            .distinct()
            .limit(body.limit)
        )
    ).all()
    return _ok(
        {"requests": [{"request_id": r, "channel": c} for r, c in rows]}
    )


class DlrResultItem(BaseModel):
    request_id: str
    contact: str
    channel: str = "sms"
    state: str = Field(..., description="delivered|failed")
    detail: str | None = None


class DlrApplyRequest(BaseModel):
    results: list[DlrResultItem] = Field(default_factory=list)


@router.post("/messaging/deliveries/dlr/apply", summary="go: DLR 결과 반영")
async def dlr_apply(
    body: DlrApplyRequest,
    db: AsyncSession = Depends(get_db),
):
    """provider 가 확정한 도달/실패를 원장에 반영. status='sent' 인 행만 전이(멱등)."""
    now = _now_utc()
    delivered = 0
    failed = 0
    touched: set[uuid.UUID] = set()
    for item in body.results:
        if item.state not in ("delivered", "failed"):
            continue
        channel = "kakao" if item.channel == "kakao" else "sms"
        contact = _normalize_contact(channel, item.contact)  # type: ignore[arg-type]
        d = (
            await db.execute(
                select(MessageDelivery).where(
                    MessageDelivery.request_id == item.request_id,
                    MessageDelivery.contact == contact,
                    MessageDelivery.status == "sent",
                )
            )
        ).scalar_one_or_none()
        if d is None:
            continue
        d.status = item.state
        d.updated_at = now
        if item.state == "delivered":
            d.delivered_at = now
            delivered += 1
            attempt_status = "delivered"
        else:
            d.reason = f"dlr:{item.detail or 'failed'}"
            failed += 1
            attempt_status = "failed"
        touched.add(d.message_id)
        latest = (
            await db.execute(
                select(MessageDeliveryAttempt)
                .where(MessageDeliveryAttempt.delivery_id == d.id)
                .order_by(MessageDeliveryAttempt.attempt_no.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if latest is not None and latest.result_status in ("inflight", "sent"):
            latest.result_status = attempt_status
            latest.finished_at = latest.finished_at or now
            latest.provider_request_id = latest.provider_request_id or item.request_id
            if item.state == "failed":
                latest.provider_error_summary = f"dlr:{item.detail or 'failed'}"
            latest.updated_at = now
    await db.commit()

    # 도달/실패 집계 캐시 갱신(요약 카드) — 원장 COUNT 재계산(로컬 카운터 덮어쓰기 금지).
    for message_id in touched:
        counts = (
            await db.execute(
                select(
                    func.count().filter(MessageDelivery.status == "delivered"),
                    func.count().filter(MessageDelivery.status == "failed"),
                ).where(MessageDelivery.message_id == message_id)
            )
        ).one()
        await db.execute(
            update(_EventMessage)
            .where(_EventMessage.id == message_id)
            .values(
                delivered_count=int(counts[0] or 0),
                failed_count=int(counts[1] or 0),
                updated_at=now,
            )
        )
    if touched:
        await db.commit()
    return _ok({"delivered": delivered, "failed": failed})


class UnknownClaimRequest(BaseModel):
    limit: int = Field(50, ge=1, le=200)


@router.post("/messaging/deliveries/unknown/claim", summary="go: unknown 대사 대상 claim")
async def unknown_claim(
    body: UnknownClaimRequest,
    db: AsyncSession = Depends(get_db),
):
    """unknown(응답 유실) delivery 를 backoff 창과 함께 claim.

    claim = next_reconcile_at 을 5분 뒤로 밀어 다음 tick 과 겹치지 않게 한다(동시 2회 실행
    시 두 번째는 같은 행을 잡지 못한다). 원장 원문 contact 는 provider 조회에 필요하므로
    **이 엔드포인트만** 원문을 반환한다(운영 화면용 목록은 전부 마스킹).
    """
    now = _now_utc()
    ids = (
        await db.execute(
            select(MessageDelivery.id)
            .where(
                MessageDelivery.status == "unknown",
                or_(
                    MessageDelivery.next_reconcile_at.is_(None),
                    MessageDelivery.next_reconcile_at <= now,
                ),
            )
            .order_by(MessageDelivery.created_at.asc())
            .limit(body.limit)
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()
    if not ids:
        await db.commit()
        return _ok({"items": []})
    await db.execute(
        update(MessageDelivery)
        .where(MessageDelivery.id.in_(ids))
        .values(next_reconcile_at=now + _td(minutes=5), updated_at=now)
    )
    rows = (
        await db.execute(select(MessageDelivery).where(MessageDelivery.id.in_(ids)))
    ).scalars().all()
    # attempt 조회 카운터 증가(대사 시도 증적) — "조회조차 못 했다"와 구분하기 위한 시작 표식.
    for d in rows:
        latest = (
            await db.execute(
                select(MessageDeliveryAttempt)
                .where(MessageDeliveryAttempt.delivery_id == d.id)
                .order_by(MessageDeliveryAttempt.attempt_no.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if latest is not None:
            latest.provider_lookup_count = (latest.provider_lookup_count or 0) + 1
            latest.provider_last_lookup_at = now
            latest.provider_last_lookup_status = "started"
            latest.updated_at = now
    await db.commit()
    return _ok(
        {
            "items": [
                {
                    "id": str(d.id),
                    "message_id": str(d.message_id),
                    "channel": d.channel,
                    "contact": d.contact,
                    "request_id": d.request_id,
                    "reconcile_attempts": d.reconcile_attempts,
                    "created_at": _iso(d.created_at),
                }
                for d in rows
            ]
        }
    )


class UnknownResultItem(BaseModel):
    delivery_id: uuid.UUID
    outcome: str = Field(..., description="delivered|sent|failed|unresolved")
    reason: str | None = None


class UnknownApplyRequest(BaseModel):
    items: list[UnknownResultItem] = Field(default_factory=list)


@router.post("/messaging/deliveries/unknown/apply", summary="go: unknown 대사 결과 반영")
async def unknown_apply(
    body: UnknownApplyRequest,
    db: AsyncSession = Depends(get_db),
):
    """provider 조회 결과로 unknown 을 확정하거나 backoff/수동검토로 승격.

    판정 정책은 v2 가 소유한다(go 는 provider 사실만 전달) — 5회 또는 120분 초과면
    manual_review 로 승격(자동 재발송 금지: 이미 나갔을 수 있는 건을 또 보내면 이중발송).
    """
    now = _now_utc()
    resolved = 0
    manual_review = 0
    touched: set[uuid.UUID] = set()
    for item in body.items:
        d = (
            await db.execute(
                select(MessageDelivery).where(
                    MessageDelivery.id == item.delivery_id,
                    MessageDelivery.status == "unknown",
                )
            )
        ).scalar_one_or_none()
        if d is None:
            continue
        attempts = int(d.reconcile_attempts or 0) + 1
        created = d.created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=_tz.utc)
        age_minutes = ((now - created).total_seconds() / 60) if created else 0
        latest = (
            await db.execute(
                select(MessageDeliveryAttempt)
                .where(MessageDeliveryAttempt.delivery_id == d.id)
                .order_by(MessageDeliveryAttempt.attempt_no.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        if item.outcome in ("delivered", "sent", "failed"):
            d.status = item.outcome
            d.reason = item.reason
            if item.outcome == "delivered":
                d.delivered_at = d.delivered_at or now
            d.reconcile_attempts = attempts
            d.last_reconciled_at = now
            d.next_reconcile_at = None
            d.claim_token = None
            d.claim_expires_at = None
            d.updated_at = now
            resolved += 1
            touched.add(d.message_id)
            if latest is not None and latest.result_status in ("inflight", "unknown"):
                latest.result_status = item.outcome
                latest.finished_at = latest.finished_at or now
                latest.provider_request_id = latest.provider_request_id or d.request_id
                latest.provider_error_summary = item.reason
                latest.provider_last_lookup_status = item.outcome
                latest.updated_at = now
            continue

        terminal = attempts >= _UNKNOWN_MAX_ATTEMPTS or age_minutes >= _UNKNOWN_MAX_AGE_MINUTES
        next_minutes = min(30, 2 ** min(attempts, 5))
        d.status = "manual_review" if terminal else "unknown"
        d.reason = item.reason
        d.reconcile_attempts = attempts
        d.reconcile_first_at = d.reconcile_first_at or d.created_at
        d.last_reconciled_at = now
        d.next_reconcile_at = None if terminal else now + _td(minutes=next_minutes)
        d.updated_at = now
        touched.add(d.message_id)
        if terminal:
            manual_review += 1
            if latest is not None and latest.result_status in ("inflight", "unknown"):
                latest.result_status = "manual_review"
                latest.finished_at = latest.finished_at or now
                latest.provider_error_summary = item.reason or "reconciliation_timeout"
                latest.provider_last_lookup_status = "manual_review"
                latest.updated_at = now
    await db.commit()
    for message_id in touched:
        await _recompute_message_status(db, message_id)
    remaining = max(len(body.items) - resolved - manual_review, 0)
    return _ok(
        {
            "checked": len(body.items),
            "resolved": resolved,
            "manual_review": manual_review,
            "remaining": remaining,
        }
    )


# ── D. 이메일 오픈/클릭 트래킹 ────────────────────────────────────────────────


class TrackingRequest(BaseModel):
    """트래킹은 서명된 토큰을 go 가 이미 검증한 뒤 호출한다(공개 픽셀/리다이렉트)."""

    message_id: uuid.UUID
    contact: str = Field(..., min_length=1)
    clicked: bool = False


@router.post("/messaging/tracking", summary="go: 이메일 오픈/클릭 기록")
async def record_tracking(
    body: TrackingRequest,
    db: AsyncSession = Depends(get_db),
):
    """opened_at/clicked_at 을 최초 1회만 기록(COALESCE 의미) — 재호출은 no-op(멱등).

    클릭은 오픈을 함의한다(픽셀 차단 환경 보정). message_id 는 event_messages.id 이거나
    email_campaigns.id 일 수 있어 **양쪽 모두** 시도한다(해당하는 쪽만 매칭).
    """
    now = _now_utc()
    contact = _normalize_contact("email", body.contact)
    delivery_cond = [
        MessageDelivery.message_id == body.message_id,
        MessageDelivery.channel == "email",
        MessageDelivery.contact == contact,
    ]
    d = (await db.execute(select(MessageDelivery).where(*delivery_cond))).scalar_one_or_none()
    matched_delivery = False
    if d is not None:
        matched_delivery = True
        if d.opened_at is None:
            d.opened_at = now
        if body.clicked and d.clicked_at is None:
            d.clicked_at = now
        d.updated_at = now

    r = (
        await db.execute(
            select(EmailCampaignRecipient).where(
                EmailCampaignRecipient.campaign_id == body.message_id,
                func.lower(EmailCampaignRecipient.email) == contact,
            )
        )
    ).scalar_one_or_none()
    matched_recipient = False
    if r is not None:
        matched_recipient = True
        if r.opened_at is None:
            r.opened_at = now
        if body.clicked and r.clicked_at is None:
            r.clicked_at = now
        r.updated_at = now
    await db.commit()
    return _ok({"delivery": matched_delivery, "campaign_recipient": matched_recipient})


# ── E. 이메일 캠페인 ──────────────────────────────────────────────────────────


class CampaignListRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID


@router.post("/messaging/campaigns/list", summary="go: 이메일 캠페인 목록")
async def list_campaigns(
    body: CampaignListRequest,
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(EmailCampaign)
            .where(
                EmailCampaign.account_id == body.go_account_id,
                EmailCampaign.event_id == body.event_id,
            )
            .order_by(EmailCampaign.created_at.desc())
        )
    ).scalars().all()
    return _ok(
        {
            "campaigns": [
                {
                    "id": str(c.id),
                    "subject": c.subject,
                    "status": c.status,
                    "stats": c.stats,
                    "scheduled_at": _iso(c.scheduled_at),
                    "sent_at": _iso(c.sent_at),
                    "created_at": _iso(c.created_at),
                }
                for c in rows
            ]
        }
    )


class CampaignGetRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    campaign_id: uuid.UUID


@router.post("/messaging/campaigns/get", summary="go: 이메일 캠페인 단건 + 실측 통계")
async def get_campaign(
    body: CampaignGetRequest,
    db: AsyncSession = Depends(get_db),
):
    c = (
        await db.execute(
            select(EmailCampaign).where(
                EmailCampaign.id == body.campaign_id,
                EmailCampaign.account_id == body.go_account_id,
                EmailCampaign.event_id == body.event_id,
            )
        )
    ).scalar_one_or_none()
    if c is None:
        return _err(ApiError("CAMPAIGN_NOT_FOUND", "campaign not found in scope", 404))
    agg = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(EmailCampaignRecipient.status == "sent"),
                func.count().filter(EmailCampaignRecipient.opened_at.isnot(None)),
                func.count().filter(EmailCampaignRecipient.clicked_at.isnot(None)),
            ).where(EmailCampaignRecipient.campaign_id == c.id)
        )
    ).one()
    total, sent, opened, clicked = (int(x or 0) for x in agg)
    return _ok(
        {
            "campaign": {
                "id": str(c.id),
                "subject": c.subject,
                "body_html": c.body_html,
                "status": c.status,
                "message_type": c.message_type,
                "segment": c.segment,
                "stats": c.stats,
                "scheduled_at": _iso(c.scheduled_at),
                "sent_at": _iso(c.sent_at),
            },
            "total_recipients": total,
            "sent": sent,
            "opened": opened,
            "clicked": clicked,
        }
    )


class CampaignMarkSentRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    campaign_id: uuid.UUID


@router.post("/messaging/campaigns/mark-sent", summary="go: 캠페인 발송 확정(중복 send 차단)")
async def mark_campaign_sent(
    body: CampaignMarkSentRequest,
    db: AsyncSession = Depends(get_db),
):
    """draft → sent 전이. **draft 인 행만** 바꾸므로 동시 2회 호출 시 한 번만 성공한다.

    실제 발송은 v2 광고성 EventMessage 로 큐잉된 뒤 Celery 가 소유한다. 이 전이는
    "같은 캠페인을 두 번 큐잉"하는 것을 막는 원장 레벨 가드다.
    """
    now = _now_utc()
    res = await db.execute(
        update(EmailCampaign)
        .where(
            EmailCampaign.id == body.campaign_id,
            EmailCampaign.account_id == body.go_account_id,
            EmailCampaign.event_id == body.event_id,
            EmailCampaign.status == "draft",
        )
        .values(status="sent", sent_at=now, updated_at=now)
    )
    await db.commit()
    if (res.rowcount or 0) == 0:
        return _err(
            ApiError("INVALID_STATE", "campaign is not in draft state", 409)
        )
    return _ok({"campaign_id": str(body.campaign_id), "status": "sent"})


# ── F. 인바운드 이메일(수신함) ────────────────────────────────────────────────
#
# 🔴 테넌트 경계: go 원본 inbound_emails 에는 account_id 가 없어 event 소유검증이 유일한
#    경계였다. v2 는 event_id 일치 + (account_id 가 있으면 반드시 일치)를 함께 요구한다.
#    account_id NULL 행은 옛 계약과 동등하게 event_id 로만 걸린다(비파괴 이관).


def _inbox_scope(body) -> list:
    return [
        InboundEmail.event_id == body.event_id,
        or_(
            InboundEmail.account_id.is_(None),
            InboundEmail.account_id == body.go_account_id,
        ),
    ]


class InboxListRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    status: str = "all"
    limit: int = Field(50, ge=1, le=200)


@router.post("/messaging/inbound-emails/list", summary="go: 수신함 목록")
async def list_inbound_emails(
    body: InboxListRequest,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(InboundEmail).where(*_inbox_scope(body))
    if body.status != "all":
        stmt = stmt.where(InboundEmail.status == body.status)
    rows = (
        await db.execute(
            stmt.order_by(InboundEmail.created_at.desc()).limit(body.limit)
        )
    ).scalars().all()
    return _ok(
        {
            "emails": [
                {
                    "id": str(e.id),
                    "from_email": e.from_email,
                    "from_name": e.from_name,
                    "subject": e.subject,
                    "status": e.status,
                    "excerpt": (e.body_text or "")[:200] or None,
                    "has_ai_draft": e.ai_draft is not None,
                    "created_at": _iso(e.created_at),
                }
                for e in rows
            ]
        }
    )


class InboxGetRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    email_id: uuid.UUID


@router.post("/messaging/inbound-emails/get", summary="go: 수신함 단건")
async def get_inbound_email(
    body: InboxGetRequest,
    db: AsyncSession = Depends(get_db),
):
    e = (
        await db.execute(
            select(InboundEmail).where(InboundEmail.id == body.email_id, *_inbox_scope(body))
        )
    ).scalar_one_or_none()
    if e is None:
        return _err(ApiError("INBOUND_EMAIL_NOT_FOUND", "email not found in scope", 404))
    return _ok(
        {
            "email": {
                "id": str(e.id),
                "from_email": e.from_email,
                "from_name": e.from_name,
                "subject": e.subject,
                "body_text": e.body_text,
                "body_html": e.body_html,
                "status": e.status,
                "ai_draft": e.ai_draft,
                "assigned_to": str(e.assigned_to) if e.assigned_to else None,
                "created_at": _iso(e.created_at),
                "updated_at": _iso(e.updated_at),
            }
        }
    )


class InboxPatchRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    email_id: uuid.UUID
    status: str | None = None
    assigned_to: uuid.UUID | None = None
    clear_assignee: bool = False


@router.post("/messaging/inbound-emails/patch", summary="go: 수신함 상태/담당자 변경")
async def patch_inbound_email(
    body: InboxPatchRequest,
    db: AsyncSession = Depends(get_db),
):
    if body.status is not None and body.status not in ("new", "replied", "archived"):
        return _err(ApiError("VALIDATION_ERROR", f"invalid status: {body.status}", 400, "status"))
    e = (
        await db.execute(
            select(InboundEmail).where(InboundEmail.id == body.email_id, *_inbox_scope(body))
        )
    ).scalar_one_or_none()
    if e is None:
        return _err(ApiError("INBOUND_EMAIL_NOT_FOUND", "email not found in scope", 404))
    if body.status is not None:
        e.status = body.status
    if body.clear_assignee:
        e.assigned_to = None
    elif body.assigned_to is not None:
        e.assigned_to = body.assigned_to
    e.updated_at = _now_utc()
    await db.commit()
    return _ok({"id": str(e.id)})


class InboxReplyRequest(BaseModel):
    go_account_id: uuid.UUID
    event_id: uuid.UUID
    email_id: uuid.UUID
    reply_body: str = Field(..., min_length=1)
    replied_by: uuid.UUID


@router.post("/messaging/inbound-emails/record-reply", summary="go: 답장 발송 감사 기록")
async def record_inbound_reply(
    body: InboxReplyRequest,
    db: AsyncSession = Depends(get_db),
):
    """답장 **실발송 성공 후** 호출되는 감사 기록(외부호출 뒤 COMMIT 경계).

    실패해도 메일은 이미 나갔다 — go 는 이 실패를 사용자에게 알리되 재발송을 유도하지 않는다.
    """
    e = (
        await db.execute(
            select(InboundEmail).where(InboundEmail.id == body.email_id, *_inbox_scope(body))
        )
    ).scalar_one_or_none()
    if e is None:
        return _err(ApiError("INBOUND_EMAIL_NOT_FOUND", "email not found in scope", 404))
    now = _now_utc()
    e.status = "replied"
    e.reply_body = body.reply_body
    e.replied_at = now
    e.replied_by = body.replied_by
    e.updated_at = now
    await db.commit()
    return _ok({"id": str(e.id)})


class InboxIngestRequest(BaseModel):
    """인바운드 웹훅 수신 — account_id/event_id 는 매칭 실패 시 null 가능(원본 동작 보존)."""

    account_id: uuid.UUID | None = None
    event_id: uuid.UUID | None = None
    from_email: str = Field(..., min_length=1)
    from_name: str | None = None
    subject: str | None = None
    body_text: str | None = None
    body_html: str | None = None


@router.post("/messaging/inbound-emails/ingest", summary="go: 인바운드 이메일 적재(웹훅)")
async def ingest_inbound_email(
    body: InboxIngestRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    """멱등키 필수 — 메일 provider 웹훅은 재시도한다. 같은 메일이 두 통으로 보이면 안 된다.

    go 는 페이로드 내용 해시를 키로 쓴다(안정 키: 같은 메일 = 같은 키). 매 호출 randomUUID 는
    멱등이 아니다.
    """

    async def _producer() -> dict:
        e = InboundEmail(
            id=uuid.uuid4(),
            account_id=body.account_id,
            event_id=body.event_id,
            from_email=body.from_email,
            from_name=body.from_name,
            subject=body.subject,
            body_text=body.body_text,
            body_html=body.body_html,
        )
        db.add(e)
        await db.commit()
        return {"id": str(e.id)}

    try:
        return await _idempotent(
            idempotency_key, "inbound_email_ingest", _producer, fingerprint=body
        )
    except ApiError as exc:
        return _err(exc)
