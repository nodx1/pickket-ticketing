"""NCP SENS 발송 어댑터(SMS·카카오 알림톡) + 전채널 ProviderSender 구현.

go 포팅 원본:
  - `organizer/src/lib/notification/sms.ts`      → NcpSensSender.send_sms
  - `organizer/src/lib/notification/alimtalk.ts` → NcpSensSender.send_alimtalk
  - `organizer/src/lib/notification/email.ts`    → providers/email.py (NcpMailerSender)

env: NCP_ACCESS_KEY / NCP_SECRET_KEY (공통)
     SENS_SMS_SERVICE_ID · SENS_SMS_FROM            (SMS/LMS)
     SENS_ALIMTALK_SERVICE_ID · SENS_ALIMTALK_CHANNEL_ID (알림톡, channel=@채널 plusFriendId)
     MAILER_SENDER_ADDRESS · MAILER_SENDER_NAME     (이메일)

━━ SMS failover(이중발송 금지) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
go 와 동일하게 **알림톡 요청 본문의 ``useSmsFailover: true``** 로 처리한다. 즉 failover 는
NCP 가 단일 요청 안에서 수행하며(알림톡 실패 시에만 SMS 대체), 우리 쪽은 **HTTP 호출을
한 번만** 한다. 클라이언트에서 "알림톡 실패를 잡아 SMS API 를 다시 호출"하는 구현은
**하지 않는다** — 그 구조는 알림톡이 실제로는 도달했는데 응답만 실패한 경우
(알림톡+SMS) 이중발송이 되기 때문이다. 결과적으로 재시도 경로에서도 발송 시도는
언제나 1건이고, 원장의 claim-lease 가 중복 워커를 다시 한번 차단한다.

━━ fail-closed ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
설정 누락·provider 오류를 성공으로 흘리지 않는다. go 의 "비프로덕션 시뮬레이션 성공"은
포팅하지 않는다(원장이 sent 로 굳으면 재발송 기회가 영원히 사라진다).
"""

from __future__ import annotations

import logging

import httpx

from app.core.config import settings
from app.services.messaging.providers.email import NcpMailerSender
from app.services.messaging.providers.ncp_client import (
    NcpCreds,
    ProviderNotConfiguredError,
    mask_contact,
    ncp_json_request,
    only_digits,
    sens_host,
)

logger = logging.getLogger(__name__)

# 90바이트(한글 약 45자) 초과 시 자동 LMS 전환 — go sms.ts 와 동일 기준.
SMS_MAX_BYTES = 90


class NcpSensSender:
    """NCP SENS(SMS/LMS·알림톡) 어댑터."""

    def __init__(
        self,
        creds: NcpCreds,
        *,
        transport: httpx.BaseTransport | None = None,
        backoff_base_ms: int = 300,
    ) -> None:
        self._creds = creds
        self._transport = transport
        self._backoff_base_ms = backoff_base_ms

    # ── SMS ──────────────────────────────────────────────────────────────────
    @staticmethod
    def sms_configured() -> bool:
        return bool(
            (settings.SENS_SMS_SERVICE_ID or "").strip()
            and (settings.SENS_SMS_FROM or "").strip()
        )

    async def send_sms(self, *, to: str, body: str, idempotency_key: str | None) -> str:
        service_id = (settings.SENS_SMS_SERVICE_ID or "").strip()
        from_number = (settings.SENS_SMS_FROM or "").strip()
        if not service_id or not from_number:
            raise ProviderNotConfiguredError(
                "NCP SENS SMS 미설정(SENS_SMS_SERVICE_ID/SENS_SMS_FROM)으로 SMS를 발송할 수 없습니다"
            )

        uri = f"/sms/v2/services/{service_id}/messages"
        msg_type = "LMS" if len(body.encode("utf-8")) > SMS_MAX_BYTES else "SMS"
        payload = {
            "type": msg_type,
            "from": only_digits(from_number),
            "content": body,
            "messages": [{"to": only_digits(to)}],
        }
        result = await ncp_json_request(
            sens_host(),
            "POST",
            uri,
            payload,
            self._creds,
            idempotency_key=idempotency_key,
            transport=self._transport,
            backoff_base_ms=self._backoff_base_ms,
        )
        request_id = str(result.get("requestId") or "")
        logger.info(
            "SMS 발송(NCP SENS): to=%s type=%s request_id=%s",
            mask_contact(to),
            msg_type,
            request_id or "(없음)",
        )
        return request_id

    # ── 알림톡 ────────────────────────────────────────────────────────────────
    @staticmethod
    def alimtalk_configured() -> bool:
        return bool(
            (settings.SENS_ALIMTALK_SERVICE_ID or "").strip()
            and (settings.SENS_ALIMTALK_CHANNEL_ID or "").strip()
        )

    async def send_alimtalk(
        self,
        *,
        to: str,
        template_code: str,
        message: str,
        idempotency_key: str | None,
        buttons: list[dict[str, str]] | None = None,
    ) -> str:
        service_id = (settings.SENS_ALIMTALK_SERVICE_ID or "").strip()
        channel_id = (settings.SENS_ALIMTALK_CHANNEL_ID or "").strip()  # plusFriendId(@채널)
        if not service_id or not channel_id:
            raise ProviderNotConfiguredError(
                "NCP SENS 알림톡 미설정(SENS_ALIMTALK_SERVICE_ID/SENS_ALIMTALK_CHANNEL_ID)으로 "
                "발송할 수 없습니다"
            )
        # 템플릿 코드는 콘솔 등록값과 정확히 일치해야 한다. 빈 값으로 외부호출하면 무조건
        # 실패하므로 호출 전에 실패시킨다(원장 failed → 코드 지정 후 재발송 가능).
        code = (template_code or "").strip()
        if not code:
            raise ValueError("알림톡 템플릿 코드가 없어 발송할 수 없습니다(templateCode 필수)")

        uri = f"/alimtalk/v2/services/{service_id}/messages"
        item: dict[str, object] = {
            "countryCode": "82",
            "to": only_digits(to),
            "content": message,
            # NCP 가 단일 요청 안에서 처리하는 failover — 우리는 SMS API 를 재호출하지 않는다.
            "useSmsFailover": True,
        }
        if buttons:
            item["buttons"] = buttons
        payload = {
            "plusFriendId": channel_id,
            # ⚠️ 정규화 금지 — 콘솔 등록 코드 그대로 전달한다.
            "templateCode": code,
            "messages": [item],
        }
        result = await ncp_json_request(
            sens_host(),
            "POST",
            uri,
            payload,
            self._creds,
            idempotency_key=idempotency_key,
            transport=self._transport,
            backoff_base_ms=self._backoff_base_ms,
        )
        request_id = str(result.get("requestId") or "")
        logger.info(
            "알림톡 발송(NCP SENS): to=%s template=%s request_id=%s",
            mask_contact(to),
            code,
            request_id or "(없음)",
        )
        return request_id


class NcpProviderSender:
    """ProviderSender Protocol 구현 — 이메일(Mailer) + SMS/알림톡(SENS).

    채널별 설정이 빠져 있으면 그 채널만 ProviderNotConfiguredError 로 실패한다
    (다른 채널은 정상 동작 — 부분 배선 상태에서 조용한 유실이 생기지 않는다).
    """

    def __init__(
        self,
        creds: NcpCreds,
        *,
        transport: httpx.BaseTransport | None = None,
        backoff_base_ms: int = 300,
    ) -> None:
        self._mailer = NcpMailerSender(
            creds, transport=transport, backoff_base_ms=backoff_base_ms
        )
        self._sens = NcpSensSender(
            creds, transport=transport, backoff_base_ms=backoff_base_ms
        )

    async def send_email(
        self, *, to: str, subject: str, body: str, idempotency_key: str | None
    ) -> str:
        return await self._mailer.send_email(
            to=to, subject=subject, body=body, idempotency_key=idempotency_key
        )

    async def send_sms(self, *, to: str, body: str, idempotency_key: str | None) -> str:
        return await self._sens.send_sms(
            to=to, body=body, idempotency_key=idempotency_key
        )

    async def send_alimtalk(
        self, *, to: str, template_code: str, message: str, idempotency_key: str | None
    ) -> str:
        return await self._sens.send_alimtalk(
            to=to,
            template_code=template_code,
            message=message,
            idempotency_key=idempotency_key,
        )


__all__ = ["SMS_MAX_BYTES", "NcpProviderSender", "NcpSensSender"]
