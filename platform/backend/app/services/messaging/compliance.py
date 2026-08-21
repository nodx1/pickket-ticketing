"""발송 컴플라이언스 게이트 — 정보통신망법(광고성 규제) + 수신거부/수신동의 + 야간발송 가드.

go organizer/src/lib/notification/compliance.ts 의 v2 포팅. 모든 발송(email/sms/alimtalk)은
디스패치 직전 이 게이트를 통과해야 한다.
  - 정보성(informational, 트랜잭션): 배달불가(bounce/complaint) 억제만 존중(동의 불요).
  - 광고성(advertising, 마케팅): 수신동의 필수 + (광고)표기 + 수신거부 + 야간(21~08 KST) 가드.

⚠️ 광고 표기 문구(applyAd*Formatting)·수신거부 토큰(HMAC)은 go legal-footer.ts / secret.ts
소유부(법무 확정 문구·시크릿). 여기서는 게이트 판정(suppression/consent/night)만 포팅하고,
광고표기 주입은 dispatch_service 에서 스텁으로 남긴다(2차: 법정 footer 상수모듈 포팅).
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.organizer_messaging import (
    MessageConsent,
    MessageConsentEvent,
    MessageSuppression,
)

Channel = Literal["email", "sms", "kakao"]
MessageType = Literal["informational", "advertising"]


def _uuid(value: str | uuid.UUID) -> uuid.UUID:
    """account_id 등 스코프 키를 UUID 로 정규화(go 는 string, v2 컬럼은 UUID).

    문자열/ UUID 모두 수용 — bind 프로세서가 UUID 객체를 요구하므로 강제 변환.
    """
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def normalize_contact(channel: Channel, contact: str) -> str:
    """이메일=소문자·trim, 전화=숫자만 (go normalizeContact 포팅)."""
    if channel == "email":
        return contact.strip().lower()
    return re.sub(r"[^0-9]", "", contact)


def is_night_window(now: datetime | None = None) -> bool:
    """야간(21:00~08:00 KST) 여부 — go isNightWindow 포팅.

    go 는 (getUTCHours()+9)%24 로 KST 시각을 구한다. 동일하게 UTC 시각 기준으로 계산.
    """
    now = now or datetime.now(timezone.utc)
    kst_hour = (now.astimezone(timezone.utc).hour + 9) % 24
    return kst_hour >= 21 or kst_hour < 8


async def is_suppressed(
    db: AsyncSession,
    account_id: str | uuid.UUID,
    channel: Channel,
    contact: str,
    *,
    undeliverable_only: bool = False,
) -> bool:
    """수신거부/억제 조회 — go isSuppressed 포팅.

    account 스코프 OR 전역(account_id NULL) 억제 모두 검사(크로스테넌트 경계 유지).
    undeliverable_only=True 면 배달불가(bounce/complaint) 사유만 검사(정보성 게이트용).
    """
    c = normalize_contact(channel, contact)
    stmt = select(MessageSuppression.id).where(
        MessageSuppression.contact == c,
        MessageSuppression.channel.in_((channel, "all")),
        (MessageSuppression.account_id == _uuid(account_id))
        | (MessageSuppression.account_id.is_(None)),
    )
    if undeliverable_only:
        stmt = stmt.where(MessageSuppression.reason.in_(("bounce", "complaint")))
    row = (await db.execute(stmt.limit(1))).first()
    return row is not None


async def filter_suppressed(
    db: AsyncSession,
    account_id: str | uuid.UUID,
    channel: Channel,
    contacts: list[str],
    *,
    undeliverable_only: bool = False,
) -> set[str]:
    """W3-MSG: 억제 **배치** 조회 — 정규화된 연락처 집합 중 억제된 것만 반환.

    go recipients.ts 가 세그먼트 수신자 전원을 한 번에 판정하려고 쓴다(수신자 수만큼
    단건 조회하면 N+1). 단건 is_suppressed 와 **동일한 술어**를 쓰므로 미리보기 인원수와
    실발송 대상이 갈라지지 않는다.

    반환 = 정규화(normalize_contact) 후의 연락처 집합. 호출자도 같은 정규화를 적용해 비교한다.
    빈 입력은 DB 를 치지 않고 빈 집합(0건 억제 ≠ 조회 실패 — 실패는 예외로 전파된다).
    """
    if not contacts:
        return set()
    normalized = {normalize_contact(channel, c) for c in contacts if c and c.strip()}
    if not normalized:
        return set()
    stmt = select(MessageSuppression.contact).where(
        MessageSuppression.contact.in_(normalized),
        MessageSuppression.channel.in_((channel, "all")),
        (MessageSuppression.account_id == _uuid(account_id))
        | (MessageSuppression.account_id.is_(None)),
    )
    if undeliverable_only:
        stmt = stmt.where(MessageSuppression.reason.in_(("bounce", "complaint")))
    rows = (await db.execute(stmt)).scalars().all()
    return set(rows)


async def has_consent(
    db: AsyncSession, account_id: str | uuid.UUID, channel: Channel, contact: str
) -> bool:
    """광고성 수신동의 여부 — go hasConsent 포팅. account 스코프 필수."""
    c = normalize_contact(channel, contact)
    stmt = select(MessageConsent.consented).where(
        MessageConsent.account_id == _uuid(account_id),
        MessageConsent.contact == c,
        MessageConsent.channel == channel,
    )
    row = (await db.execute(stmt.limit(1))).scalar_one_or_none()
    return row is True


async def has_night_consent(
    db: AsyncSession, account_id: str | uuid.UUID, channel: Channel, contact: str
) -> bool:
    """야간 광고 수신 별도동의 — go hasNightConsent 포팅."""
    c = normalize_contact(channel, contact)
    stmt = select(MessageConsent.night_consented).where(
        MessageConsent.account_id == _uuid(account_id),
        MessageConsent.contact == c,
        MessageConsent.channel == channel,
    )
    row = (await db.execute(stmt.limit(1))).scalar_one_or_none()
    return row is True


@dataclass(frozen=True)
class AdGateResult:
    ok: bool
    reason: Literal["suppressed", "no_consent", "night"] | None = None


async def can_send_ad(
    db: AsyncSession,
    account_id: str | uuid.UUID,
    channel: Channel,
    contact: str,
    now: datetime | None = None,
) -> AdGateResult:
    """광고성 발송 가능 여부 — go canSendAd 포팅.

    순서: 수신거부 → 수신동의 → 야간(21~08 KST, 야간동의 없으면 차단).
    """
    if await is_suppressed(db, account_id, channel, contact):
        return AdGateResult(ok=False, reason="suppressed")
    if not await has_consent(db, account_id, channel, contact):
        return AdGateResult(ok=False, reason="no_consent")
    if is_night_window(now) and not await has_night_consent(db, account_id, channel, contact):
        return AdGateResult(ok=False, reason="night")
    return AdGateResult(ok=True)


async def can_send_info(
    db: AsyncSession, account_id: str | uuid.UUID, channel: Channel, contact: str
) -> bool:
    """정보성(거래) 발송 가능 여부 — go canSendInfo 포팅.

    배달불가(bounce/complaint)만 차단. 마케팅 거부는 무시(거래는 계속 발송).
    """
    return not await is_suppressed(
        db, account_id, channel, contact, undeliverable_only=True
    )


async def suppress(
    db: AsyncSession,
    account_id: str | uuid.UUID | None,
    channel: Channel | Literal["all"],
    contact: str,
    reason: Literal["unsubscribe", "bounce", "complaint", "manual"] = "unsubscribe",
) -> None:
    """억제 목록 추가 — go suppress 포팅. account_id NULL = 전역.

    COALESCE 전역 유니크(orgmsg_0724 idx_msg_suppress_uniq)에 의해 (account/global, contact,
    channel) 중복은 자연 차단된다. INSERT .. ON CONFLICT DO NOTHING 으로 동시 unsubscribe도
    멱등 처리한다.
    """
    c = contact.strip().lower() if channel == "all" else normalize_contact(channel, contact)
    acct = _uuid(account_id) if account_id is not None else None
    try:
        dialect = db.get_bind().dialect.name
    except Exception:  # noqa: BLE001 — production 기본값은 PostgreSQL
        dialect = "postgresql"
    insert_ctor = sqlite_insert if dialect == "sqlite" else pg_insert
    stmt = (
        insert_ctor(MessageSuppression)
        .values(account_id=acct, contact=c, channel=channel, reason=reason)
        # PostgreSQL의 COALESCE 표현식 유니크 인덱스는 conflict target을
        # column-list로 표현할 수 없으므로 target 없이 모든 unique 충돌을 흡수한다.
        .on_conflict_do_nothing()
    )
    await db.execute(stmt)


async def fetch_consents(
    db: AsyncSession,
    account_id: str | uuid.UUID,
    channel: Channel,
    contacts: list[str],
) -> dict[str, tuple[bool, bool]]:
    """W3-MSG: 수신동의 **배치** 조회 — {정규화 연락처: (consented, night_consented)}.

    행이 없는 연락처는 dict 에 등장하지 않는다(= 미동의). 호출자는 `.get(c, (False, False))`
    로 읽어 **부재를 동의로 승격하지 않는다**(광고 게이트 fail-closed).
    """
    if not contacts:
        return {}
    normalized = {normalize_contact(channel, c) for c in contacts if c and c.strip()}
    if not normalized:
        return {}
    stmt = select(
        MessageConsent.contact, MessageConsent.consented, MessageConsent.night_consented
    ).where(
        MessageConsent.account_id == _uuid(account_id),
        MessageConsent.channel == channel,
        MessageConsent.contact.in_(normalized),
    )
    rows = (await db.execute(stmt)).all()
    return {r[0]: (bool(r[1]), bool(r[2])) for r in rows}


async def record_consent(
    db: AsyncSession,
    account_id: str | uuid.UUID,
    channel: Channel,
    contact: str,
    *,
    consented: bool = True,
    night_consented: bool = False,
    source: str | None = None,
    wording_version: str | None = None,
) -> None:
    """마케팅 수신동의 취득 — go recordConsent(§3-2) 포팅.

    현재상태 UPSERT + 이벤트 원장 append. **원 동의시점(first_consented_at)과 문구버전은
    덮어쓰지 않고 보존**한다(법정 이력). consented_at 은 최신 동의 시점(2년 재확인 기준일)으로 갱신.
    """
    c = normalize_contact(channel, contact)
    acct = _uuid(account_id)
    now = datetime.now(timezone.utc)
    try:
        dialect = db.get_bind().dialect.name
    except Exception:  # noqa: BLE001 — production 기본값은 PostgreSQL
        dialect = "postgresql"
    insert_ctor = sqlite_insert if dialect == "sqlite" else pg_insert
    base = insert_ctor(MessageConsent).values(
        account_id=acct,
        contact=c,
        channel=channel,
        consented=consented,
        night_consented=night_consented,
        source=source,
        wording_version=wording_version,
        first_consented_at=now,
        consented_at=now,
    )
    stmt = base.on_conflict_do_update(
        index_elements=[
            MessageConsent.account_id,
            MessageConsent.contact,
            MessageConsent.channel,
        ],
        set_={
            "consented": base.excluded.consented,
            "night_consented": base.excluded.night_consented,
            "consented_at": now,
            "source": base.excluded.source,
            # 문구버전은 신규 값이 없으면 기존 값 보존.
            "wording_version": func.coalesce(
                base.excluded.wording_version, MessageConsent.wording_version
            ),
            # 원 동의시점 보존(덮어쓰기 금지).
            "first_consented_at": func.coalesce(
                MessageConsent.first_consented_at, base.excluded.first_consented_at
            ),
            "reconfirm_requested_at": None,
            "updated_at": now,
        },
    )
    await db.execute(stmt)
    db.add(
        MessageConsentEvent(
            account_id=acct,
            contact=c,
            channel=channel,
            action="grant" if consented else "withdraw",
            consented=consented,
            night_consented=night_consented,
            wording_version=wording_version,
            source=source,
            occurred_at=now,
        )
    )


async def withdraw_consent(
    db: AsyncSession,
    account_id: str | uuid.UUID,
    channel: Channel,
    contact: str,
    source: str = "unsubscribe",
) -> None:
    """수신동의 철회 — go withdrawConsent(§3-2) 포팅. 수신거부와 연동해 호출된다.

    현재상태 consented=false + 이벤트 원장 append. 동의 행이 없어도 원장에는 남긴다
    (철회 요청 사실 자체가 법정 이력).
    """
    c = normalize_contact(channel, contact)
    acct = _uuid(account_id)
    now = datetime.now(timezone.utc)
    await db.execute(
        update(MessageConsent)
        .where(
            MessageConsent.account_id == acct,
            MessageConsent.contact == c,
            MessageConsent.channel == channel,
        )
        .values(consented=False, updated_at=now)
    )
    db.add(
        MessageConsentEvent(
            account_id=acct,
            contact=c,
            channel=channel,
            action="withdraw",
            consented=False,
            source=source,
            occurred_at=now,
        )
    )
