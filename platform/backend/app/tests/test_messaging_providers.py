"""W5-PROVIDER — NCP 발송 provider 실배선 회귀.

증명 대상:
  - 서명 생성이 NCP 규격(METHOD URI\\n timestamp\\n accessKey → HMAC-SHA256 base64)과 일치.
  - 알림톡 템플릿 코드가 **정규화 없이 그대로** 전달(콘솔 등록값 불일치 = 전 발송 실패).
  - provider 오류를 성공으로 흘리지 않음(fail-closed): 4xx 예외 전파 / POST 5xx·전송오류 =
    AmbiguousProviderError(unknown → 자동 재발송 금지).
  - SMS failover 가 **단일 발송**(알림톡 1콜, 클라이언트측 SMS 재호출 없음 = 이중발송 없음).
  - 미설정 채널은 외부호출 없이 즉시 명확한 실패(ProviderNotConfiguredError).
  - 멱등키가 결정론적(랜덤 UUID 아님) → 재시도가 같은 키로 나감.
  - 원장이 provider request_id 를 기록(중복 발송 판별 근거).

⚠️ 전부 mock(httpx.MockTransport) 기반 — 실 NCP 로 HTTP 를 쏘지 않는다.
   자격증명은 테스트용 더미이며 실키를 넣지 않는다.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.core.config import Settings, settings
from app.models.organizer_messaging import MessageDelivery
from app.services.messaging.dispatch_service import (
    AmbiguousProviderError,
    DispatchParams,
    NotImplementedProviderSender,
    dispatch_one,
)
from app.services.messaging.providers import (
    NcpProviderSender,
    ProviderNotConfiguredError,
    provider_status,
    resolve_provider_sender,
)
from app.services.messaging.providers import alimtalk_templates as tpl
from app.services.messaging.providers.ncp_client import (
    NcpCreds,
    make_ncp_signature,
    mask_contact,
    ncp_json_request,
)

# 테스트 전용 더미 자격증명(실키 아님 — 실키는 env 에서만 읽는다).
_DUMMY_ACCESS = "dummy-access-key"
_DUMMY_SECRET = "dummy-secret-key"
_DUMMY_CREDS = NcpCreds(access_key=_DUMMY_ACCESS, secret_key=_DUMMY_SECRET)


@pytest.fixture
def ncp_configured(monkeypatch):
    """NCP 전 채널 설정 완비 상태(더미 값)."""
    monkeypatch.setattr(settings, "NCP_ACCESS_KEY", _DUMMY_ACCESS)
    monkeypatch.setattr(settings, "NCP_SECRET_KEY", _DUMMY_SECRET)
    monkeypatch.setattr(settings, "SENS_ALIMTALK_SERVICE_ID", "ncp:kkobizmsg:test")
    monkeypatch.setattr(settings, "SENS_ALIMTALK_CHANNEL_ID", "@pickket")
    monkeypatch.setattr(settings, "SENS_SMS_SERVICE_ID", "ncp:sms:test")
    monkeypatch.setattr(settings, "SENS_SMS_FROM", "0212345678")
    monkeypatch.setattr(settings, "MAILER_SENDER_ADDRESS", "support@pickket.kr")
    monkeypatch.setattr(settings, "MAILER_SENDER_NAME", "PICKKET")
    monkeypatch.setattr(settings, "ORGANIZER_MESSAGING_PROVIDER", "auto")


class Recorder:
    """MockTransport 핸들러 — 요청을 기록하고 지정 응답을 돌려준다."""

    def __init__(self, responses=None, status: int = 200, body: dict | None = None):
        self.requests: list[httpx.Request] = []
        self._responses = list(responses or [])
        self._status = status
        self._body = body if body is not None else {"requestId": "REQ-TEST-1"}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self._responses:
            nxt = self._responses.pop(0)
            if isinstance(nxt, Exception):
                raise nxt
            return nxt
        return httpx.Response(self._status, json=self._body)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def payload(self, index: int = 0) -> dict:
        return json.loads(self.requests[index].content.decode("utf-8"))


def _sender(recorder: Recorder) -> NcpProviderSender:
    # backoff 0 — 테스트가 실제로 잠들지 않게.
    return NcpProviderSender(
        _DUMMY_CREDS, transport=recorder.transport, backoff_base_ms=0
    )


# ── 서명 ──────────────────────────────────────────────────────────────────────


def test_signature_matches_ncp_spec():
    """StringToSign = 'METHOD URI\\ntimestamp\\naccessKey' 의 HMAC-SHA256 base64."""
    ts = "1700000000000"
    uri = "/alimtalk/v2/services/svc/messages"
    expected = base64.b64encode(
        hmac.new(
            _DUMMY_SECRET.encode("utf-8"),
            f"POST {uri}\n{ts}\n{_DUMMY_ACCESS}".encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode()
    assert make_ncp_signature("POST", uri, ts, _DUMMY_CREDS) == expected


@pytest.mark.asyncio
async def test_signature_headers_sent_and_consistent(ncp_configured):
    """헤더의 timestamp/accessKey 가 서명에 쓰인 값과 동일해야 NCP 가 수락한다."""
    rec = Recorder()
    await _sender(rec).send_sms(to="010-1234-5678", body="본문", idempotency_key="k1")

    req = rec.requests[0]
    ts = req.headers["x-ncp-apigw-timestamp"]
    assert req.headers["x-ncp-iam-access-key"] == _DUMMY_ACCESS
    assert req.headers["x-ncp-apigw-signature-v2"] == make_ncp_signature(
        "POST", str(req.url.path), ts, _DUMMY_CREDS
    )
    # 비밀키가 헤더/본문 어디에도 실려나가지 않는다.
    assert _DUMMY_SECRET not in json.dumps(dict(req.headers))
    assert _DUMMY_SECRET not in req.content.decode("utf-8")


# ── 템플릿 코드 정확성 ────────────────────────────────────────────────────────


def test_template_codes_are_console_literals():
    """콘솔 등록 코드와 글자 그대로 일치. 임의 정규화 금지."""
    assert tpl.INVITATION_ISSUED_CODE == "PICKKETINVITE001"
    assert "_" not in tpl.INVITATION_ISSUED_CODE  # 카카오 승인 완료 코드(언더바 없음)
    assert tpl.PURCHASE_CONFIRM_CODE == "PICKKET_PURCHASE_001"
    assert tpl.REMINDER_D7_CODE == "PICKKET_REMIND_D7"
    assert tpl.REMINDER_D1_CODE == "PICKKET_REMIND_D1"
    # 🔴 언더바가 있으면 NCP 등록 자체가 불가하다. go 승인본과 같은 값이어야 한다.
    assert tpl.CANCEL_CONFIRM_CODE == "PICKKETCANCEL001"
    assert "_" not in tpl.CANCEL_CONFIRM_CODE, "NCP 코드는 영문+숫자만 받는다"
    assert tpl.CHECKIN_QR_CODE == "PICKKET_CHECKIN_001"


def test_invitation_body_matches_approved_wording():
    """카카오 승인 문안(발신주체 + '고객님께서 요청하신' + ▶/※ 구조)을 유지."""
    body = tpl.invitation_issued_body(
        event_title="테스트대회", event_date="2026-08-20", venue_name="테스트구장"
    )
    assert body.startswith("[초대권] 테스트대회 초대권")
    assert "초대권 서비스 '피켓'입니다." in body
    assert "고객님께서 요청하신 테스트대회 초대권이 도착했습니다." in body
    assert "▶ 대회일자 : 2026-08-20" in body
    assert "※ 대회장소 : 테스트구장" in body
    assert "※ 본 초대권의 사용은 대회기간 중 1회에 한합니다." in body


@pytest.mark.asyncio
async def test_alimtalk_passes_template_code_verbatim(ncp_configured):
    """templateCode·plusFriendId 가 정규화 없이 그대로 전달된다."""
    rec = Recorder(body={"requestId": "REQ-AT-1"})
    request_id = await _sender(rec).send_alimtalk(
        to="010-1234-5678",
        template_code=tpl.INVITATION_ISSUED_CODE,
        message="본문",
        idempotency_key="idem-1",
    )

    assert request_id == "REQ-AT-1"
    payload = rec.payload()
    assert payload["templateCode"] == "PICKKETINVITE001"
    assert payload["plusFriendId"] == "@pickket"
    msg = payload["messages"][0]
    assert msg["countryCode"] == "82"
    assert msg["to"] == "01012345678"  # 숫자만 정규화
    assert msg["content"] == "본문"
    assert "/alimtalk/v2/services/ncp:kkobizmsg:test/messages" in str(rec.requests[0].url)


@pytest.mark.asyncio
async def test_alimtalk_without_template_code_fails_without_call(ncp_configured):
    """템플릿 코드 없는 알림톡은 외부호출 없이 실패(무의미한 발송 시도 금지)."""
    rec = Recorder()
    with pytest.raises(ValueError):
        await _sender(rec).send_alimtalk(
            to="01012345678", template_code="", message="본문", idempotency_key=None
        )
    assert rec.requests == []


# ── SMS failover(이중발송 금지) ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_alimtalk_failover_is_single_send(ncp_configured):
    """failover 는 NCP 가 단일 요청 안에서 처리 — 우리는 알림톡 1콜만 한다."""
    rec = Recorder()
    await _sender(rec).send_alimtalk(
        to="01012345678",
        template_code=tpl.INVITATION_ISSUED_CODE,
        message="본문",
        idempotency_key="idem-fo",
    )
    assert len(rec.requests) == 1
    assert rec.payload()["messages"][0]["useSmsFailover"] is True
    assert "/sms/v2/" not in str(rec.requests[0].url)


@pytest.mark.asyncio
async def test_alimtalk_failure_does_not_trigger_client_side_sms(ncp_configured):
    """알림톡 실패 시 클라이언트가 SMS 를 재호출하지 않는다(알림톡+SMS 이중발송 방지)."""
    rec = Recorder(responses=[httpx.Response(400, json={"errorCode": "400"})])
    with pytest.raises(RuntimeError):
        await _sender(rec).send_alimtalk(
            to="01012345678",
            template_code=tpl.INVITATION_ISSUED_CODE,
            message="본문",
            idempotency_key="idem-fo2",
        )
    assert len(rec.requests) == 1
    assert all("/sms/v2/" not in str(r.url) for r in rec.requests)


# ── fail-closed(오류 전파) ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_4xx_propagates_as_error(ncp_configured):
    """4xx(서명·검증·템플릿 오류)는 재시도 없이 즉시 실패 — 성공으로 흘리지 않는다."""
    rec = Recorder(responses=[httpx.Response(401, text="Unauthorized")])
    with pytest.raises(RuntimeError) as ei:
        await _sender(rec).send_sms(to="01012345678", body="본문", idempotency_key="k")
    assert "401" in str(ei.value)
    assert len(rec.requests) == 1  # 재시도 없음


@pytest.mark.asyncio
async def test_post_5xx_is_ambiguous(ncp_configured):
    """POST 5xx = provider 처리 여부 불명확 → unknown 확정(자동 재발송 금지)."""
    rec = Recorder(responses=[httpx.Response(503, text="unavailable")])
    with pytest.raises(AmbiguousProviderError) as ei:
        await _sender(rec).send_sms(to="01012345678", body="본문", idempotency_key="k")
    assert ei.value.http_status == 503
    assert ei.value.timeout_stage == "provider_response"


@pytest.mark.asyncio
async def test_transport_error_is_ambiguous(ncp_configured):
    """전송 오류(타임아웃 등)도 도달 여부 불명 → ambiguous(중복발송 위험 차단)."""
    rec = Recorder(responses=[httpx.ConnectTimeout("timeout")])
    with pytest.raises(AmbiguousProviderError) as ei:
        await _sender(rec).send_email(
            to="a@x.io", subject="제목", body="본문", idempotency_key="k"
        )
    assert ei.value.timeout_stage == "transport"
    assert ei.value.idempotency_key == "k"


# ── 미설정 = 명확한 실패 ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unconfigured_channel_fails_without_network(monkeypatch, ncp_configured):
    """채널 설정 누락 시 외부호출 없이 ProviderNotConfiguredError — 조용한 성공 금지."""
    monkeypatch.setattr(settings, "SENS_ALIMTALK_SERVICE_ID", "")
    monkeypatch.setattr(settings, "MAILER_SENDER_ADDRESS", "")
    rec = Recorder()
    sender = _sender(rec)

    with pytest.raises(ProviderNotConfiguredError):
        await sender.send_alimtalk(
            to="01012345678", template_code="X", message="본문", idempotency_key=None
        )
    with pytest.raises(ProviderNotConfiguredError):
        await sender.send_email(
            to="a@x.io", subject="제목", body="본문", idempotency_key=None
        )
    assert rec.requests == []  # 미설정이면 발송을 시도조차 하지 않는다.


def test_resolve_sender_falls_back_to_stub_when_unset(monkeypatch):
    """자격증명 미설정 → 미배선 스텁(삭제 금지 폴백)."""
    monkeypatch.setattr(settings, "NCP_ACCESS_KEY", "")
    monkeypatch.setattr(settings, "NCP_SECRET_KEY", "")
    assert isinstance(resolve_provider_sender(), NotImplementedProviderSender)
    assert provider_status()["wired"] is False


def test_resolve_sender_uses_real_sender_when_configured(ncp_configured):
    """설정 완비 → 실 sender 배선."""
    assert isinstance(resolve_provider_sender(), NcpProviderSender)
    st = provider_status()
    assert st["wired"] is True
    assert st["email"] is True and st["sms"] is True and st["alimtalk"] is True
    # 상태 점검에 자격증명 값이 새지 않는다.
    assert _DUMMY_SECRET not in json.dumps(st)


def test_kill_switch_forces_stub(ncp_configured, monkeypatch):
    """ORGANIZER_MESSAGING_PROVIDER=disabled → 키가 있어도 실발송 차단."""
    monkeypatch.setattr(settings, "ORGANIZER_MESSAGING_PROVIDER", "disabled")
    assert isinstance(resolve_provider_sender(), NotImplementedProviderSender)


def test_default_mode_is_disabled_so_keys_alone_do_not_start_sending():
    """🔴 기본값은 disabled — 키 주입만으로 실발송이 개시되면 안 된다.

    "auto" 가 기본이면 env 에 NCP 키를 넣는 순간 리마인더 beat(매일 00:00 KST)가 대상
    전원에게 과금 발송을 시작한다. 준비(키)와 개시(스위치)는 분리한다.
    """
    assert Settings.model_fields["ORGANIZER_MESSAGING_PROVIDER"].default == "disabled"


@pytest.mark.asyncio
async def test_host_override_must_be_https(ncp_configured, monkeypatch):
    """평문 host 오버라이드 거부 — 인증키·수신자 정보가 평문으로 나가면 안 된다."""
    monkeypatch.setattr(settings, "NCP_SENS_HOST", "http://evil.example.com")
    rec = Recorder()
    with pytest.raises(ProviderNotConfiguredError):
        await _sender(rec).send_sms(to="01012345678", body="본문", idempotency_key="k")
    assert rec.requests == []


@pytest.mark.asyncio
async def test_host_override_restricted_to_official_domain_in_production(
    ncp_configured, monkeypatch
):
    """프로덕션에서는 공식 NCP 도메인만 — 임의 호스트는 유효 서명 수집 경로가 된다."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "NCP_SENS_HOST", "https://evil.example.com")
    rec = Recorder()
    with pytest.raises(ProviderNotConfiguredError):
        await _sender(rec).send_sms(to="01012345678", body="본문", idempotency_key="k")
    assert rec.requests == []

    # 공식 도메인은 통과.
    monkeypatch.setattr(settings, "NCP_SENS_HOST", "https://sens.apigw.ntruss.com")
    await _sender(rec).send_sms(to="01012345678", body="본문", idempotency_key="k")
    assert len(rec.requests) == 1


@pytest.mark.asyncio
async def test_stub_raises_not_implemented():
    """폴백 스텁은 조용히 성공하지 않는다."""
    with pytest.raises(NotImplementedError):
        await NotImplementedProviderSender().send_alimtalk(to="x", template_code="y")


# ── 멱등성 ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_idempotency_key_is_forwarded(ncp_configured):
    rec = Recorder()
    await _sender(rec).send_sms(
        to="01012345678", body="본문", idempotency_key="message:m1:sms:abcd"
    )
    assert rec.requests[0].headers["X-Idempotency-Key"] == "message:m1:sms:abcd"


@pytest.mark.asyncio
async def test_idempotency_key_is_deterministic_without_caller_key(ncp_configured):
    """호출측 키가 없어도 랜덤 UUID 를 쓰지 않는다 — 같은 요청은 같은 키."""
    rec1, rec2 = Recorder(), Recorder()
    await _sender(rec1).send_sms(to="01012345678", body="본문", idempotency_key=None)
    await _sender(rec2).send_sms(to="01012345678", body="본문", idempotency_key=None)
    k1 = rec1.requests[0].headers["X-Idempotency-Key"]
    k2 = rec2.requests[0].headers["X-Idempotency-Key"]
    assert k1 == k2 and k1.startswith("ncp:")

    # 본문이 달라지면 키도 달라진다(다른 논리 발송).
    rec3 = Recorder()
    await _sender(rec3).send_sms(to="01012345678", body="다른본문", idempotency_key=None)
    assert rec3.requests[0].headers["X-Idempotency-Key"] != k1


@pytest.mark.asyncio
async def test_retry_reuses_same_body_and_idempotency_key(ncp_configured):
    """429 재시도는 같은 body·같은 멱등키로만 — provider 중복 방어가 성립하려면 필수."""
    rec = Recorder(
        responses=[
            httpx.Response(429, text="rate limited"),
            httpx.Response(200, json={"requestId": "REQ-RETRY"}),
        ]
    )
    request_id = await _sender(rec).send_sms(
        to="01012345678", body="본문", idempotency_key="stable-key"
    )
    assert request_id == "REQ-RETRY"
    assert len(rec.requests) == 2
    assert {r.headers["X-Idempotency-Key"] for r in rec.requests} == {"stable-key"}
    assert rec.requests[0].content == rec.requests[1].content


# ── 채널별 페이로드 ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_email_payload_shape(ncp_configured):
    rec = Recorder(body={"requestId": "REQ-MAIL", "count": 1})
    request_id = await _sender(rec).send_email(
        to="buyer@example.com", subject="제목", body="<p>본문</p>", idempotency_key="k"
    )
    assert request_id == "REQ-MAIL"
    payload = rec.payload()
    assert payload["senderAddress"] == "support@pickket.kr"
    assert payload["senderName"] == "PICKKET"
    assert payload["title"] == "제목"
    assert payload["body"] == "<p>본문</p>"
    assert payload["recipients"] == [{"address": "buyer@example.com", "type": "R"}]
    assert payload["individual"] is True  # 수신자 상호 노출 방지
    assert "/api/v1/mails" in str(rec.requests[0].url)


@pytest.mark.asyncio
async def test_sms_switches_to_lms_over_90_bytes(ncp_configured):
    rec = Recorder()
    sender = _sender(rec)
    await sender.send_sms(to="01012345678", body="가" * 10, idempotency_key="a")
    assert rec.payload(0)["type"] == "SMS"

    await sender.send_sms(to="01012345678", body="가" * 40, idempotency_key="b")
    assert rec.payload(1)["type"] == "LMS"
    assert rec.payload(1)["from"] == "0212345678"


# ── 보안(마스킹·네트워크 차단) ────────────────────────────────────────────────


def test_mask_contact_hides_pii():
    assert mask_contact("buyer@example.com") == "b***@example.com"
    assert mask_contact("010-1234-5678") == "***5678"
    assert mask_contact("") == "(없음)"


@pytest.mark.asyncio
async def test_logs_do_not_leak_secrets_or_full_contact(ncp_configured, caplog):
    rec = Recorder()
    with caplog.at_level("INFO"):
        await _sender(rec).send_alimtalk(
            to="01012345678",
            template_code=tpl.INVITATION_ISSUED_CODE,
            message="본문",
            idempotency_key="k",
        )
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert _DUMMY_SECRET not in text
    assert _DUMMY_ACCESS not in text
    assert "01012345678" not in text  # 전체 연락처 금지
    assert "***5678" in text


@pytest.mark.asyncio
async def test_real_network_is_blocked_under_pytest(ncp_configured):
    """transport 주입 없이 pytest 안에서 실 HTTP 를 열 수 없다(실발송 안전망)."""
    with pytest.raises(RuntimeError, match="차단"):
        await ncp_json_request(
            "https://sens.apigw.ntruss.com",
            "POST",
            "/sms/v2/services/x/messages",
            {"a": 1},
            _DUMMY_CREDS,
        )


# ── 원장 통합(provider request_id 기록) ───────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_one_records_provider_request_id(db_session, ncp_configured):
    """실 sender 경로: 원장에 provider request_id 가 남아야 중복발송 판별이 가능하다."""
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    rec = Recorder(body={"requestId": "REQ-LEDGER-1"})
    params = DispatchParams(
        account_id=acct,
        channel="email",
        message_type="informational",
        to="buyer@example.com",
        body="본문",
        subject="제목",
        message_id=mid,
    )
    r = await dispatch_one(db_session, params, sender=_sender(rec))
    assert r.status == "sent" and r.request_id == "REQ-LEDGER-1"

    d = (
        await db_session.execute(
            select(MessageDelivery).where(MessageDelivery.message_id == uuid.UUID(mid))
        )
    ).scalar_one()
    assert d.status == "sent" and d.request_id == "REQ-LEDGER-1"

    # 재실행(동시 2회 실행 시나리오): 원장 claim 이 막아 외부호출이 다시 나가지 않는다.
    rec2 = Recorder(body={"requestId": "REQ-LEDGER-2"})
    r2 = await dispatch_one(db_session, params, sender=_sender(rec2))
    assert r2.status == "skipped"
    assert rec2.requests == []


@pytest.mark.asyncio
async def test_advertising_send_is_blocked_until_legal_footer_is_wired(
    db_session, ncp_configured
):
    """광고 법정표기(게이트 3) 미포팅 동안 광고성 이메일/SMS 는 실발송되지 않는다.

    provider 배선의 부수효과로 "(광고)" 표기·무료수신거부 없는 광고가 나가면 안 된다
    (배선 전 동작 = 미발송을 그대로 유지하되, 조용히 성공시키지 않고 원장 failed).
    """
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    rec = Recorder()
    params = DispatchParams(
        account_id=acct,
        channel="email",
        message_type="advertising",
        to="buyer@example.com",
        body="광고 본문",
        subject="광고 제목",
        message_id=mid,
        # 광고 컴플라이언스 게이트(동의·야간)는 별도 — 여기서는 게이트 통과 후 차단을 본다.
    )
    r = await dispatch_one(db_session, params, sender=_sender(rec))
    assert r.status in ("failed", "skipped")
    assert rec.requests == []  # 외부 발송 없음.


@pytest.mark.asyncio
async def test_dispatch_one_records_failed_when_provider_unconfigured(
    db_session, monkeypatch, ncp_configured
):
    """미설정 채널은 원장에 failed 로 남는다 — sent 로 굳어 재발송 기회가 사라지면 안 된다."""
    monkeypatch.setattr(settings, "MAILER_SENDER_ADDRESS", "")
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    rec = Recorder()
    params = DispatchParams(
        account_id=acct,
        channel="email",
        message_type="informational",
        to="buyer@example.com",
        body="본문",
        subject="제목",
        message_id=mid,
    )
    r = await dispatch_one(db_session, params, sender=_sender(rec))
    assert r.status == "failed"
    assert rec.requests == []

    d = (
        await db_session.execute(
            select(MessageDelivery).where(MessageDelivery.message_id == uuid.UUID(mid))
        )
    ).scalar_one()
    assert d.status == "failed"
    assert d.claim_token is None  # lease 해제 → 설정 후 재드레인 가능.
