import uuid

import pytest

from app.services.identity_service import IdentityService
from app.services.sms_service import NullSMSProvider, get_sms_provider


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method_name", "args"),
    [
        ("verify_identity", (uuid.uuid4(), "ci-hash", "di-hash")),
        ("verify_phone", (uuid.uuid4(), "+821012345678")),
        ("verify_foreign", (uuid.uuid4(), "passport-hash")),
    ],
)
async def test_identity_service_rejects_calls_when_provider_is_disabled(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    method_name: str,
    args: tuple,
):
    monkeypatch.setattr("app.services.identity_service.settings.IDENTITY_PROVIDER", "none")
    service = IdentityService(db_session)

    with pytest.raises(ValueError, match="Identity verification is not configured"):
        await getattr(service, method_name)(*args)


@pytest.mark.asyncio
async def test_get_sms_provider_returns_null_provider_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr("app.services.sms_service.settings.SMS_PROVIDER", "none")

    provider = get_sms_provider()

    assert isinstance(provider, NullSMSProvider)
    assert await provider.send("+821012345678", "hello") is False
