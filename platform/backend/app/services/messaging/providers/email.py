"""이메일 발송 — NCP Cloud Outbound Mailer (go `organizer/src/lib/notification/email.ts` 포팅).

발신주소(senderAddress)는 콘솔에서 도메인 인증(SPF/DKIM/DMARC + 소유권 토큰) + 발신주소 등록이
선행되어야 한다(pickket.kr). serviceId 는 필요 없다.

env: NCP_ACCESS_KEY / NCP_SECRET_KEY (공통), MAILER_SENDER_ADDRESS, MAILER_SENDER_NAME(선택)

⚠️ go 는 비프로덕션에서 "시뮬레이션 성공"을 반환하지만, v2 는 **시뮬레이션을 하지 않는다**.
   미설정이면 ProviderNotConfiguredError 로 명확히 실패한다(원장 failed → 설정 후 재발송 가능).
   조용한 성공 위장은 재발송 기회를 영구히 없앤다.
"""

from __future__ import annotations

import logging

import httpx

from app.core.config import settings
from app.services.messaging.providers.ncp_client import (
    NcpCreds,
    ProviderNotConfiguredError,
    mailer_host,
    mask_contact,
    ncp_json_request,
)

logger = logging.getLogger(__name__)

MAILER_URI = "/api/v1/mails"


class NcpMailerSender:
    """NCP Cloud Outbound Mailer 이메일 어댑터.

    transport 는 테스트 주입용(httpx.MockTransport). 운영에서는 None.
    """

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

    @staticmethod
    def is_configured() -> bool:
        return bool((settings.MAILER_SENDER_ADDRESS or "").strip())

    async def send_email(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        idempotency_key: str | None,
        reply_to: str | None = None,
    ) -> str:
        sender_address = (settings.MAILER_SENDER_ADDRESS or "").strip()
        if not sender_address:
            raise ProviderNotConfiguredError(
                "NCP Outbound Mailer 미설정(MAILER_SENDER_ADDRESS)으로 이메일을 발송할 수 없습니다"
            )

        payload: dict[str, object] = {
            "senderAddress": sender_address,
            "senderName": (settings.MAILER_SENDER_NAME or "").strip() or "PICKKET",
            "title": subject,
            "body": body,
            "recipients": [{"address": to, "type": "R"}],
            # 개별 발송 — 수신자끼리 서로 노출되지 않는다.
            "individual": True,
        }
        if reply_to:
            payload["replyToAddress"] = reply_to

        result = await ncp_json_request(
            mailer_host(),
            "POST",
            MAILER_URI,
            payload,
            self._creds,
            idempotency_key=idempotency_key,
            transport=self._transport,
            backoff_base_ms=self._backoff_base_ms,
        )
        request_id = str(result.get("requestId") or "")
        logger.info(
            "이메일 발송(NCP Mailer): to=%s request_id=%s",
            mask_contact(to),
            request_id or "(없음)",
        )
        return request_id


__all__ = ["MAILER_URI", "NcpMailerSender"]
