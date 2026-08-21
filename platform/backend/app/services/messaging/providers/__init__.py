"""발송 provider 배선 — 설정이 갖춰졌을 때만 실 sender, 아니면 명시적 미배선 스텁.

배선 규칙(조용한 실패 금지):
  - ``ORGANIZER_MESSAGING_PROVIDER=disabled``(**기본값**) → 항상 스텁. 키를 넣어도 발송하지
    않는다. 키 주입(준비)과 발송 개시(결정)를 분리하기 위한 것 — "auto" 가 기본이면 env 에
    키를 넣는 순간 리마인더 beat 가 대상 전원에게 실발송을 시작한다.
  - NCP 공통 인증키(NCP_ACCESS_KEY/NCP_SECRET_KEY) 미설정 → 스텁(NotImplementedProviderSender).
    스텁은 호출 시 NotImplementedError 를 던지고, 호출측이 원장을 failed(provider_unwired)로
    스윕한다 → "발송됨" 위장 없음, 설정 후 재드레인으로 복구 가능.
  - 인증키 설정 → NcpProviderSender. 채널별 부가설정(SENS_*/MAILER_*)이 빠진 채널만
    ProviderNotConfiguredError 로 실패한다(원장 failed).

⚠️ 이 모듈은 **자격증명 값을 로깅하지 않는다**. 상태 점검은 boolean 만 노출한다.
"""

from __future__ import annotations

import logging

import httpx

from app.core.config import settings
from app.services.messaging.dispatch_service import (
    NotImplementedProviderSender,
    ProviderSender,
)
from app.services.messaging.providers.email import NcpMailerSender
from app.services.messaging.providers.ncp import NcpProviderSender, NcpSensSender
from app.services.messaging.providers.ncp_client import (
    NcpCreds,
    ProviderNotConfiguredError,
    get_ncp_creds,
)

logger = logging.getLogger(__name__)

_DISABLED_MODES = {"disabled", "none", "stub", "off"}


def resolve_provider_sender(
    *, transport: httpx.BaseTransport | None = None
) -> ProviderSender:
    """현재 설정에 맞는 ProviderSender 를 반환한다(실 sender 또는 미배선 스텁).

    transport 는 테스트 주입용(httpx.MockTransport). 운영에서는 None.
    """
    mode = (settings.ORGANIZER_MESSAGING_PROVIDER or "auto").strip().lower()
    if mode in _DISABLED_MODES:
        logger.info("발송 provider 비활성(ORGANIZER_MESSAGING_PROVIDER=%s) — 스텁 사용", mode)
        return NotImplementedProviderSender()

    creds = get_ncp_creds()
    if creds is None:
        # 명시적으로 ncp 를 요구했는데 키가 없으면 설정 오류다 — 조용히 넘기지 않는다.
        log = logger.error if mode == "ncp" else logger.warning
        log(
            "NCP 공통 인증키 미설정(NCP_ACCESS_KEY/NCP_SECRET_KEY) — 실발송 불가, 미배선 스텁 사용"
        )
        return NotImplementedProviderSender()

    return NcpProviderSender(creds, transport=transport)


def provider_status() -> dict[str, bool | str]:
    """운영 점검용 배선 상태(값 노출 없음 — boolean 만).

    실발송 없이 "지금 배선이 끝났는가"를 확인하기 위한 용도.
    """
    mode = (settings.ORGANIZER_MESSAGING_PROVIDER or "auto").strip().lower()
    creds_ok = get_ncp_creds() is not None
    return {
        "mode": mode,
        "ncp_credentials": creds_ok,
        "email": creds_ok and NcpMailerSender.is_configured(),
        "sms": creds_ok and NcpSensSender.sms_configured(),
        "alimtalk": creds_ok and NcpSensSender.alimtalk_configured(),
        "wired": creds_ok and mode not in _DISABLED_MODES,
    }


__all__ = [
    "NcpCreds",
    "NcpMailerSender",
    "NcpProviderSender",
    "NcpSensSender",
    "ProviderNotConfiguredError",
    "get_ncp_creds",
    "provider_status",
    "resolve_provider_sender",
]
