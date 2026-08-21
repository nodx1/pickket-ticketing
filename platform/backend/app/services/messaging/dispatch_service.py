"""단일 발송 dispatch — 모든 조직자 메시징 발송의 공통 진입점(컴플라이언스 게이트 + 원장).

go organizer/src/lib/notification/dispatch.ts::dispatchOne 의 v2 포팅(2차 = 실동작).

게이트 순서(go 와 동일):
  1) 채널 규칙: 알림톡(kakao)은 정보성 전용(카카오 규정). 광고성 알림톡은 금지 → skip.
  2) 컴플라이언스:
       광고성: 수신거부·수신동의·야간(21~08 KST) 검사 → 실패 시 skip(사유 기록).
       정보성: 배달불가(bounce/complaint) 억제만 검사.
  3) 광고 표기 자동주입(이메일 (광고)+수신거부 footer / SMS (광고)+무료거부) — ⚠️ **미포팅**
     (알림톡/법무 세션 소유: legal-footer 상수·HMAC 수신거부 토큰 — 대표 조율 대기).
     그동안 광고성 이메일/SMS 는 발송하지 않는다(AdFormattingUnwiredError → 원장 failed).
  4) 실제 provider 발송 — W5-PROVIDER 로 **실배선 완료**(app/services/messaging/providers).
     설정(NCP_ACCESS_KEY/NCP_SECRET_KEY 등)이 갖춰지면 NcpProviderSender, 미설정이면
     NotImplementedProviderSender 폴백(조용한 실패 금지 → 원장 failed 로 표면화).

트랜잭션·멱등 계약(2차 = 증명 완료):
  - 멱등: message_deliveries UNIQUE(message_id, channel, contact) + 발송 전 status='sending'
    선기록(claim-lease). "동시 2회 실행" → ledger.claim_delivery 의 원자 INSERT…ON CONFLICT
    가 단일 소유자만 RETURNING → 두 번째 실행은 claim 실패로 외부호출 자체가 발생하지 않음.
  - 트랜잭션 경계: 선기록(claim + attempt) → **COMMIT** → provider 외부호출 → sent/unknown/
    failed 결과로 원장 정정(2차 COMMIT). "외부호출 후 crash" → delivery 는 'sending' 잔류
    (claim_token 有) → lease(15분) 유효 동안 재발송 금지, 만료 후 reconcile/재드레인이 승계.
    unknown(모호)은 자동 재발송 금지(reconcile/수동검토 대상).

⚠️ dispatch_one 은 게이트 통과분만 선기록한다(skip 은 원장 기록 없이 즉시 반환). message_id 가
   없는 단발성 발송(트리거 직결)은 event_messages 헤더 없이도 message_id(=논리 발송 그룹 id)
   를 요구한다 — 원장 멱등키의 필수 성분이기 때문(트리거측이 안정 id 공급).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import Literal, Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.messaging import compliance, ledger
from app.services.messaging.compliance import Channel, MessageType

# event_messages 저장 채널과 compliance/provider 내부 채널은 계약이 다르다.
# alimtalk은 카카오 알림톡(kakao)으로 정규화하고, push는 이 조직자 발송 원장에서
# 지원하지 않으므로 조용히 알림톡으로 보내지 않는다.
DispatchChannel = Literal["email", "sms", "kakao", "alimtalk", "push"]
_CHANNEL_MAP: dict[str, Channel] = {
    "email": "email",
    "sms": "sms",
    "kakao": "kakao",
    "alimtalk": "kakao",
}


def normalize_channel(channel: str) -> Channel | None:
    """저장/외부 입력 채널을 dispatch 내부 채널로 정규화한다.

    ``None``은 현재 조직자 메시징 provider가 지원하지 않는 채널(push 포함)이다.
    모든 dispatch 진입점은 이 함수를 통과해야 compliance와 원장 키가 같은 채널을
    사용한다.
    """

    return _CHANNEL_MAP.get(channel)


# ── 발송 파라미터 / 결과 ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class DispatchParams:
    account_id: str
    channel: DispatchChannel
    message_type: MessageType
    to: str  # 이메일 또는 전화번호
    body: str
    subject: str | None = None  # 이메일 전용
    template_code: str | None = None  # 알림톡 전용(카카오 승인 템플릿)
    message_id: str | None = None  # 원장 멱등키 성분(발송 그룹 id). 실발송 경로는 필수.
    idempotency_key: str | None = None  # 단체/재처리 경로가 고정한 provider attempt key


SkipReason = Literal[
    "suppressed",
    "no_consent",
    "night",
    "alimtalk_ad_forbidden",
    "no_contact",
    "unsupported_channel",
]


@dataclass(frozen=True)
class DispatchResult:
    status: Literal["sent", "skipped", "unknown", "failed"]
    reason: SkipReason | str | None = None
    request_id: str | None = None
    error: str | None = None


# ── provider 발송 인터페이스(실배선 = app/services/messaging/providers) ───────


class AmbiguousProviderError(Exception):
    """전송 후 결과 불확실(타임아웃 등) — 자동 재발송 금지, unknown 확정 (go NcpAmbiguousError).

    idempotency_key/http_status/timeout_stage 는 reconcile 대사·수동검토용.
    """

    def __init__(
        self,
        message: str,
        *,
        idempotency_key: str | None = None,
        http_status: int | None = None,
        timeout_stage: str | None = None,
    ) -> None:
        super().__init__(message)
        self.idempotency_key = idempotency_key
        self.http_status = http_status
        self.timeout_stage = timeout_stage


class AdFormattingUnwiredError(Exception):
    """광고 법정표기(게이트 3) 미구현 상태에서 광고성 발송을 차단한다 — 배선의 부수효과 봉인.

    go dispatchOne 은 광고성 이메일/SMS 에 applyAdEmailFormatting/applyAdSmsFormatting 으로
    "(광고)" 표기와 무료수신거부 안내를 주입한다(정보통신망법). v2 는 이 주입이 아직
    포팅되지 않았다(legal-footer 상수·HMAC 수신거부 토큰 = 알림톡/법무 세션 소유부).

    ⚠️ W5-PROVIDER 이전에는 광고 발송이 미배선 스텁에서 실패해 **실제로 나가지 않았다**.
       provider 만 배선하고 이 가드를 두지 않으면 배선의 부수효과로 **법정표기 없는 광고가
       실발송**된다. 종전과 동일하게 차단하되, 조용히 성공시키지 않고 원장 failed 로 남긴다.
       게이트 3 포팅이 끝나면 이 가드를 제거한다(광고성 알림톡은 이미 게이트 1에서 금지).
    """


class ProviderSender(Protocol):
    """실제 NCP 발송 어댑터 인터페이스. 구현 = providers.NcpProviderSender(W5-PROVIDER)."""

    async def send_email(
        self, *, to: str, subject: str, body: str, idempotency_key: str | None
    ) -> str: ...

    async def send_sms(
        self, *, to: str, body: str, idempotency_key: str | None
    ) -> str: ...

    async def send_alimtalk(
        self, *, to: str, template_code: str, message: str, idempotency_key: str | None
    ) -> str: ...


class NotImplementedProviderSender:
    """미배선 폴백 스텁 — NCP 설정이 없을 때 쓰인다. 호출 시 명시적 미구현.

    ⚠️ 삭제하지 말 것. 조용한 실패 금지: 자격증명 미설정 상태에서 발송이 시도되면
    "발송됨" 위장 대신 즉시 드러나야 한다(호출측이 원장을 failed 로 스윕).
    """

    async def send_email(self, **_kwargs) -> str:  # noqa: ANN003
        raise NotImplementedError("email provider 미배선(NCP 자격증명·발신주소 미설정)")

    async def send_sms(self, **_kwargs) -> str:  # noqa: ANN003
        raise NotImplementedError("sms provider 미배선(NCP 자격증명·발신번호 미설정)")

    async def send_alimtalk(self, **_kwargs) -> str:  # noqa: ANN003
        raise NotImplementedError("alimtalk provider 미배선(NCP 자격증명·채널 미설정)")


def default_sender() -> ProviderSender:
    """현재 설정에 맞는 기본 sender — 설정 완비 시 실 NCP sender, 아니면 미배선 스텁.

    ⚠️ 지연 import: providers 패키지가 이 모듈의 AmbiguousProviderError/ProviderSender 를
    참조하므로 모듈 최상단에서 import 하면 순환이 된다.
    """
    from app.services.messaging.providers import resolve_provider_sender

    return resolve_provider_sender()


# ── 게이트 판정(외부호출/원장 write 없음) ────────────────────────────────────


async def evaluate_compliance_gate(
    db: AsyncSession, p: DispatchParams, *, now: datetime | None = None
) -> DispatchResult | None:
    """컴플라이언스 게이트 판정만 수행(go dispatchOne 의 게이트 1~2 포팅).

    반환:
      - DispatchResult(status='skipped', reason=...) : 발송 차단(사유 기록용).
      - None : 게이트 통과(발송 진행 가능).

    순수 판정만(원장 write·외부호출 없음).
    """
    channel = normalize_channel(p.channel)
    if channel is None:
        return DispatchResult(status="skipped", reason="unsupported_channel")

    if not p.to or not p.to.strip():
        return DispatchResult(status="skipped", reason="no_contact")

    # 게이트 1: 알림톡은 정보성 전용(광고성 알림톡 금지 → 친구톡/이메일로).
    if channel == "kakao" and p.message_type == "advertising":
        return DispatchResult(status="skipped", reason="alimtalk_ad_forbidden")

    # 게이트 2: 컴플라이언스.
    if p.message_type == "advertising":
        ad = await compliance.can_send_ad(db, p.account_id, channel, p.to, now)
        if not ad.ok:
            return DispatchResult(status="skipped", reason=ad.reason or "suppressed")
    else:
        if not await compliance.can_send_info(db, p.account_id, channel, p.to):
            return DispatchResult(status="skipped", reason="suppressed")

    return None  # 통과.


async def _call_provider(
    sender: ProviderSender, p: DispatchParams, *, idem: str
) -> str:
    """채널별 provider 외부호출 — request_id(NCP requestId/messageId) 반환.

    ⚠️ 게이트 3(광고표기 자동주입)은 알림톡/법무 세션 소유부(legal-footer 상수·HMAC) — 미포팅.
       그동안 광고성 이메일/SMS 는 **발송하지 않는다**(AdFormattingUnwiredError). 포팅 후
       여기 직전에서 (광고)표기·무료수신거부 footer 를 주입하고 이 가드를 제거한다.
    """
    if p.message_type == "advertising" and p.channel in ("email", "sms"):
        raise AdFormattingUnwiredError(
            "광고성 발송은 법정표기((광고)·무료수신거부) 자동주입이 구현될 때까지 차단됩니다"
        )
    if p.channel == "email":
        return await sender.send_email(
            to=p.to, subject=p.subject or "", body=p.body, idempotency_key=idem
        )
    if p.channel == "sms":
        return await sender.send_sms(to=p.to, body=p.body, idempotency_key=idem)
    return await sender.send_alimtalk(
        to=p.to, template_code=p.template_code or "", message=p.body, idempotency_key=idem
    )


async def dispatch_one(
    db: AsyncSession,
    p: DispatchParams,
    *,
    sender: ProviderSender | None = None,
    now: datetime | None = None,
    record_ledger: bool = True,
) -> DispatchResult:
    """단일 발송 진입점(2차 실동작).

    흐름(트랜잭션 경계 증명):
      1) 게이트 판정. skip → 원장 기록 없이 즉시 반환(외부호출 없음).
      2) message_id 있음 + record_ledger → claim_delivery(선기록 sending) + create_attempt →
         **COMMIT**(선기록 확정). claim 실패(중복 워커/lease 유효) → 조용히 skipped 반환.
      3) provider 외부호출.
      4) 결과(sent/unknown/failed) 로 finalize_delivery(원장 정정) → **COMMIT**.

    record_ledger=False(테스트·원장 불필요 단발) 는 게이트 후 곧장 provider 호출(선기록 생략).
    이 경우 멱등은 provider idempotency_key 에만 의존한다(단발 트리거는 message_id 필수 권장).
    """
    channel = normalize_channel(p.channel)
    if channel is None:
        return DispatchResult(status="skipped", reason="unsupported_channel")
    if p.channel != channel:
        p = replace(p, channel=channel)

    gate = await evaluate_compliance_gate(db, p, now=now)
    if gate is not None:
        return gate

    sender = sender or default_sender()
    idem = p.idempotency_key or (
        ledger.stable_idempotency_key(p.message_id, p.channel, p.to)
        if p.message_id
        else None
    )

    # ── 원장 미사용 경로(선기록 생략) ────────────────────────────────────────
    if not (record_ledger and p.message_id):
        try:
            request_id = await _call_provider(sender, p, idem=idem or "")
            return DispatchResult(status="sent", request_id=request_id)
        except AmbiguousProviderError as e:
            # ⚠️ provider 원문 오류에는 NCP 가 에코한 수신번호가 섞일 수 있다. 원장 경로가
            #    finalize 에서 하는 PII 세탁(summarize_provider_error)을 여기서도 반드시
            #    통과시킨다 — 이 error 는 API 응답 본문으로 나가 호출측 로그에 남는다.
            masked = ledger.summarize_provider_error(str(e))
            return DispatchResult(status="unknown", error=masked, reason="unknown")
        except NotImplementedError:
            raise
        except Exception as e:  # noqa: BLE001 — provider 실패는 결과로 표면화
            masked = ledger.summarize_provider_error(str(e))
            return DispatchResult(status="failed", error=masked, reason=masked)

    # ── 원장 경로: 선기록 → COMMIT → 외부호출 → 정정 → COMMIT ─────────────────
    claimed = await ledger.claim_delivery(
        db,
        message_id=p.message_id,
        account_id=p.account_id,
        channel=p.channel,
        contact=p.to,
        now=now,
    )
    if claimed is None:
        # 중복 워커/유효 lease — 이미 다른 소유자가 처리 중이거나 종결됨. 재발송 금지.
        return DispatchResult(status="skipped", reason="suppressed")

    attempt_id = await ledger.create_attempt(
        db,
        claimed=claimed,
        message_id=p.message_id,
        account_id=p.account_id,
        channel=p.channel,
        idempotency_key=idem or ledger.stable_idempotency_key(
            p.message_id, p.channel, p.to
        ),
    )
    if attempt_id is None:
        await db.rollback()
        return DispatchResult(status="skipped", reason="suppressed")

    # 트랜잭션 경계: 선기록 확정. crash 시 delivery 는 'sending'(lease) → 재발송 금지.
    await db.commit()

    idem = idem or ledger.stable_idempotency_key(p.message_id, p.channel, p.to)
    status: str
    reason: str | None = None
    request_id: str | None = None
    http_status: int | None = None
    timeout_stage: str | None = None
    ambiguous = False
    try:
        request_id = await _call_provider(sender, p, idem=idem)
        status = "sent"
    except AmbiguousProviderError as e:
        status, reason, ambiguous = "unknown", str(e), True
        http_status, timeout_stage = e.http_status, e.timeout_stage
    except NotImplementedError:
        # 스텁: 선기록은 남았고 외부발송 안 됨. 원장은 sending 잔류(재드레인 승계) — raise 유지
        # 하되 dispatch_one 호출측(테스트·배치)이 sending 을 실패로 스윕하도록 트랜잭션은 깨끗.
        raise
    except Exception as e:  # noqa: BLE001
        status, reason = "failed", str(e)

    ok = await ledger.finalize_delivery(
        db,
        claimed=claimed,
        message_id=p.message_id,
        account_id=p.account_id,
        channel=p.channel,
        status=status,
        reason=reason,
        request_id=request_id,
        attempt_id=attempt_id,
        http_status=http_status,
        timeout_stage=timeout_stage,
        ambiguous=ambiguous,
    )
    await db.commit()
    if not ok:
        # claim 을 잃음(reconcile/타 워커가 선점 종결). 결과는 skipped 로 보고.
        return DispatchResult(status="skipped", reason="suppressed")

    if status == "sent":
        return DispatchResult(status="sent", request_id=request_id)
    if status == "unknown":
        return DispatchResult(status="unknown", error=reason, reason="unknown")
    return DispatchResult(status="failed", error=reason, reason=reason)


__all__ = [
    "AdFormattingUnwiredError",
    "AmbiguousProviderError",
    "DispatchParams",
    "DispatchResult",
    "NotImplementedProviderSender",
    "ProviderSender",
    "default_sender",
    "dispatch_one",
    "evaluate_compliance_gate",
]
