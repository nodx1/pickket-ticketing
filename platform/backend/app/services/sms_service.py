"""SMS service with provider abstraction (stub / NCP / Twilio).

External sends (NCP / Twilio) are wrapped with @with_retry for transient failures.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import time
from abc import ABC, abstractmethod

import httpx

from app.core.config import settings
from app.core.http_client import traced_headers
from app.core.resilience import with_retry

logger = logging.getLogger(__name__)


class SMSProvider(ABC):
    @abstractmethod
    async def send(self, to: str, message: str) -> bool: ...


class StubSMSProvider(SMSProvider):
    async def send(self, to: str, message: str) -> bool:
        logger.info("STUB SMS -> to=%s message=%s", to, message)
        return True


class NullSMSProvider(SMSProvider):
    """Explicitly disabled SMS provider."""

    async def send(self, to: str, message: str) -> bool:
        logger.warning("SMS disabled (SMS_PROVIDER=none): to=%s", to)
        return False


class NCPSMSProvider(SMSProvider):
    _base_url = "https://sens.apigw.ntruss.com"

    def _build_signature(self, timestamp: str, method: str, path: str) -> str:
        message = f"{method} {path}\n{timestamp}\n{settings.NCP_SMS_ACCESS_KEY}"
        signing_key = bytes(settings.NCP_SMS_SECRET_KEY, "utf-8")
        signature = hmac.new(signing_key, message.encode("utf-8"), hashlib.sha256).digest()
        return base64.b64encode(signature).decode("utf-8")

    @with_retry(max_attempts=3, backoff_base=2, retry_on=(Exception,), exclude=(ValueError,))
    async def send(self, to: str, message: str) -> bool:
        service_id = settings.NCP_SMS_SERVICE_ID
        if not service_id or not settings.NCP_SMS_ACCESS_KEY or not settings.NCP_SMS_SECRET_KEY:
            logger.warning("NCP SMS credentials missing; send skipped")
            return False

        path = f"/sms/v2/services/{service_id}/messages"
        timestamp = str(int(time.time() * 1000))
        headers = traced_headers({
            "Content-Type": "application/json; charset=utf-8",
            "x-ncp-apigw-timestamp": timestamp,
            "x-ncp-iam-access-key": settings.NCP_SMS_ACCESS_KEY,
            "x-ncp-apigw-signature-v2": self._build_signature(timestamp, "POST", path),
        })
        payload = {
            "type": "SMS",
            "contentType": "COMM",
            "from": settings.NCP_SMS_FROM_NUMBER,
            "content": message,
            "messages": [{"to": to}],
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{self._base_url}{path}", headers=headers, json=payload)
            return resp.status_code in (200, 201, 202)


class TwilioSMSProvider(SMSProvider):
    @with_retry(max_attempts=3, backoff_base=2, retry_on=(Exception,), exclude=(ValueError,))
    async def send(self, to: str, message: str) -> bool:
        sid = settings.TWILIO_ACCOUNT_SID
        token = settings.TWILIO_AUTH_TOKEN
        from_number = settings.TWILIO_FROM_NUMBER

        if not sid or not token or not from_number:
            logger.warning("Twilio credentials missing; send skipped")
            return False

        url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
        data = {
            "To": to,
            "From": from_number,
            "Body": message,
        }

        async with httpx.AsyncClient(timeout=10.0, auth=(sid, token)) as client:
            resp = await client.post(url, data=data)
            return resp.status_code in (200, 201)


def get_sms_provider() -> SMSProvider:
    if settings.SMS_PROVIDER == "none":
        return NullSMSProvider()
    providers = {
        "ncp": NCPSMSProvider,
        "twilio": TwilioSMSProvider,
        "stub": StubSMSProvider,
    }
    cls = providers.get(settings.SMS_PROVIDER, StubSMSProvider)
    return cls()


class SMSService:
    def __init__(self):
        self.provider = get_sms_provider()

    async def send_transfer_code(self, to: str, code: str) -> bool:
        message = f"[Pickket] 양도 인증번호는 {code} 입니다. 3분 내 입력해주세요."
        return await self.provider.send(to, message)

    async def send_payment_authorized(self, to: str, event_title: str, amount: float) -> bool:
        message = (
            f"[Pickket] {event_title} 가승인 완료. "
            f"금액 {amount:,.0f}원은 카드 한도 임시 차감 상태입니다."
        )
        return await self.provider.send(to, message)

    async def send_payment_captured(self, to: str, event_title: str, amount: float) -> bool:
        message = f"[Pickket] {event_title} 매입 완료. 결제 금액 {amount:,.0f}원이 확정되었습니다."
        return await self.provider.send(to, message)
