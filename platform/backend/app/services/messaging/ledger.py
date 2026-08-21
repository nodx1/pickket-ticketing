"""message_deliveries 원장 claim-lease / 선기록 / 정정 (go attempts.ts + run-dispatch 포팅).

트랜잭션·멱등 계약(설계 증명):
  - 멱등: UNIQUE(message_id, channel, contact)(orgmsg_0724). 발송 전 status='sending' 선기록.
    "동시 2회 실행" → claim_delivery 의 원자 INSERT…ON CONFLICT DO UPDATE … WHERE(failed/만료)
    가 단일 소유자만 RETURNING → 두 번째 실행은 RETURNING 이 비어 외부호출 자체가 발생 안 함.
  - 트랜잭션 경계: claim_delivery(선기록)는 **호출측이 COMMIT** 후 provider 외부호출을 한다.
    "외부호출 후 crash" → 재실행 시 delivery 는 아직 'sending'(claim_token 有) → claim WHERE
    가 (failed OR 만료 sending)만 재획득하므로 lease 유효 동안 재발송 금지. lease 만료 후
    reconcile/재드레인이 unknown/재시도로 승계. unknown 은 자동 재발송하지 않는다.

⚠️ 이 모듈은 원장 write 만 한다(외부 provider 호출 없음). 세션 commit 시점은 호출측 소유.
   dispatch_one(단건)·Celery 배치 경로가 공유한다.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.organizer_messaging import (
    MessageDelivery,
    MessageDeliveryAttempt,
)
from app.services.messaging.compliance import Channel, normalize_contact

CLAIM_LEASE_MINUTES = 15


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid(value: str | uuid.UUID) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def _dialect_name(db: AsyncSession) -> str:
    """세션 바인드 방언명(postgresql/sqlite) — UPSERT 구문 분기용."""
    try:
        return db.get_bind().dialect.name
    except Exception:  # noqa: BLE001 — 바인드 조회 실패 시 prod 기본
        return "postgresql"


def recipient_hash(contact: str) -> str:
    """대사 상관관계용 단방향 hash — 원장에 원문 대신 hash 저장(go recipientHash)."""
    return hashlib.sha256(contact.strip().lower().encode()).hexdigest()


_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
_PHONE_RE = re.compile(r"\+?\d[\d\s().-]{7,}\d")


def summarize_provider_error(value: str | None) -> str | None:
    """provider 오류 원문의 PII(이메일/전화) 세탁 + 300자 절단 (go summarizeProviderError)."""
    if not value:
        return None
    masked = _EMAIL_RE.sub("[email]", value)
    masked = _PHONE_RE.sub("[phone]", masked)
    return masked[:300]


def stable_idempotency_key(message_id: str | uuid.UUID, channel: Channel, contact: str) -> str:
    """(message, channel, contact) 안정 멱등키 — provider 중복 방어 (go stableIdempotencyKey).

    contact 은 hash 로 감싸 PII 를 키에 노출하지 않는다.
    """
    ch = hashlib.sha256(contact.encode()).hexdigest()
    return f"message:{message_id}:{channel}:{ch}"


def provider_for_channel(channel: Channel) -> str:
    return "ncp-mailer" if channel == "email" else "ncp-sens"


@dataclass(frozen=True)
class ClaimedDelivery:
    delivery_id: uuid.UUID
    contact: str  # 정규화된 contact
    claim_token: uuid.UUID


async def claim_delivery(
    db: AsyncSession,
    *,
    message_id: str | uuid.UUID,
    account_id: str | uuid.UUID,
    channel: Channel,
    contact: str,
    now: datetime | None = None,
) -> ClaimedDelivery | None:
    """단일 수신자 delivery 를 원자적으로 claim(status='sending', claim_token).

    ⚠️ 호출측이 이 함수 반환 후 **COMMIT** 해야 lease 가 확정된다(트랜잭션 경계).
    반환 None = 이미 다른 소유자가 sending(lease 유효) 또는 이미 sent/skipped(재발송 불가).

    go run-dispatch 의 INSERT … ON CONFLICT DO UPDATE … WHERE (failed OR 만료 sending) 포팅.
    신규 삽입 또는 (failed·만료 sending) 재획득만 RETURNING → 나머지는 스킵.
    """
    now = now or _now()
    c = normalize_contact(channel, contact)
    if not c:
        return None
    token = uuid.uuid4()
    expires = now + timedelta(minutes=CLAIM_LEASE_MINUTES)

    # 방언별 UPSERT 구문 — prod=Postgres, test=SQLite(3.35+ ON CONFLICT DO UPDATE RETURNING).
    insert_ctor = sqlite_insert if _dialect_name(db) == "sqlite" else pg_insert

    stmt = (
        insert_ctor(MessageDelivery)
        .values(
            message_id=_uuid(message_id),
            source="message",
            account_id=_uuid(account_id),
            channel=channel,
            contact=c,
            status="sending",
            claim_token=token,
            claim_expires_at=expires,
        )
        .on_conflict_do_update(
            index_elements=["message_id", "channel", "contact"],
            set_={
                "status": "sending",
                "claim_token": token,
                "claim_expires_at": expires,
                "updated_at": now,
            },
            where=or_(
                MessageDelivery.status == "failed",
                and_(
                    MessageDelivery.status == "sending",
                    MessageDelivery.claim_expires_at.isnot(None),
                    MessageDelivery.claim_expires_at <= now,
                ),
            ),
        )
        .returning(MessageDelivery.id, MessageDelivery.claim_token)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        return None
    return ClaimedDelivery(delivery_id=row[0], contact=c, claim_token=row[1])


async def create_attempt(
    db: AsyncSession,
    *,
    claimed: ClaimedDelivery,
    message_id: str | uuid.UUID,
    account_id: str | uuid.UUID,
    channel: Channel,
    idempotency_key: str,
    request_fingerprint: str | None = None,
) -> uuid.UUID | None:
    """claim_token 검증하며 attempt_no 를 원자적으로 할당(go createDeliveryAttempt).

    delivery 가 여전히 sending + 우리 claim_token 소유일 때만 attempt INSERT.
    반환 None = claim 을 이미 잃음(중복 워커) → 발송 진행 금지.
    ⚠️ 호출측이 이 함수 후 COMMIT(선기록 확정) 해야 외부호출 안전.
    """
    # populate_existing: claim_delivery 는 Core UPSERT(ORM 우회)라 identity-map 이 stale 할 수 있다.
    # DB 실값으로 갱신해 claim_token/status 를 신뢰(재claim 시 stale 비교로 None 반환 방지).
    delivery = (
        await db.execute(
            select(MessageDelivery)
            .where(
                MessageDelivery.id == claimed.delivery_id,
                MessageDelivery.claim_token == claimed.claim_token,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if delivery is None or delivery.status != "sending" or delivery.claim_token != claimed.claim_token:
        return None

    last = (
        await db.execute(
            select(MessageDeliveryAttempt.attempt_no)
            .where(MessageDeliveryAttempt.delivery_id == claimed.delivery_id)
            .order_by(MessageDeliveryAttempt.attempt_no.desc())
            .limit(1)
            .with_for_update()
        )
    ).scalar_one_or_none()
    attempt = MessageDeliveryAttempt(
        delivery_id=claimed.delivery_id,
        message_id=_uuid(message_id),
        account_id=_uuid(account_id),
        channel=channel,
        provider=provider_for_channel(channel),
        recipient_hash=recipient_hash(claimed.contact),
        idempotency_key=idempotency_key,
        claim_token=claimed.claim_token,
        request_fingerprint=request_fingerprint,
        attempt_no=(last or 0) + 1,
        result_status="inflight",
    )
    db.add(attempt)
    await db.flush()
    return attempt.id


async def finalize_delivery(
    db: AsyncSession,
    *,
    claimed: ClaimedDelivery,
    message_id: str | uuid.UUID,
    account_id: str | uuid.UUID,
    channel: Channel,
    status: str,  # sent/skipped/failed/unknown/manual_review/cancelled
    reason: str | None,
    request_id: str | None,
    attempt_id: uuid.UUID | None = None,
    http_status: int | None = None,
    timeout_stage: str | None = None,
    ambiguous: bool | None = None,
    provider_error_code: str | None = None,
) -> bool:
    """delivery + attempt 를 한 트랜잭션에서 종결(go finalizeDeliveryAttempt).

    delivery 가 여전히 sending + 우리 claim_token 소유일 때만 정정(claim 손실 시 no-op).
    반환 False = claim 을 잃음(다른 워커/reconcile 이 이미 종결) → 카운트 반영 금지.
    ⚠️ 호출측이 이 함수 후 COMMIT.
    """
    res = await db.execute(
        update(MessageDelivery)
        .where(
            MessageDelivery.id == claimed.delivery_id,
            MessageDelivery.message_id == _uuid(message_id),
            MessageDelivery.account_id == _uuid(account_id),
            MessageDelivery.channel == channel,
            MessageDelivery.status == "sending",
            MessageDelivery.claim_token == claimed.claim_token,
        )
        .values(
            status=status,
            reason=summarize_provider_error(reason),
            request_id=request_id,
            claim_token=None,
            claim_expires_at=None,
            updated_at=_now(),
        )
    )
    if (res.rowcount or 0) == 0:
        return False

    if attempt_id is not None:
        # skipped 는 attempt 결과로는 failed(발송 미도달), review/cancel 은 그대로.
        result_status = (
            status
            if status in ("manual_review", "cancelled")
            else ("failed" if status == "skipped" else status)
        )
        await db.execute(
            update(MessageDeliveryAttempt)
            .where(
                MessageDeliveryAttempt.id == attempt_id,
                MessageDeliveryAttempt.result_status == "inflight",
            )
            .values(
                result_status=result_status,
                finished_at=_now(),
                provider_request_id=request_id,
                http_status=http_status,
                provider_error_code=provider_error_code,
                provider_error_summary=summarize_provider_error(reason),
                timeout_stage=timeout_stage,
                ambiguous=ambiguous if ambiguous is not None else (status == "unknown"),
                updated_at=_now(),
            )
        )
    return True
