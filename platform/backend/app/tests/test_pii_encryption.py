from datetime import date
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text

from app.core.config import Settings
from app.core.pii import (
    phone_lookup_digest,
    phone_lookup_digests,
    reset_pii_fernet_cache,
)
from app.models.user import User
from app.tests.conftest import TestSession


@pytest.mark.asyncio
async def test_user_phone_and_birthdate_are_encrypted_at_rest(client, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY", Fernet.generate_key().decode())
    reset_pii_fernet_cache()

    user_id = uuid4()
    async with TestSession() as session:
        user = User(
            id=user_id,
            email="pii-encrypted@example.com",
            hashed_password="hashed",
            name="Encrypted User",
            phone="+821012345678",
            date_of_birth=date(1990, 1, 2),
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)

        row = (
            await session.execute(
                text("SELECT phone, date_of_birth FROM users WHERE id = :user_id"),
                {"user_id": user_id.hex},
            )
        ).one()
        assert row.phone.startswith("enc::")
        assert row.phone != "+821012345678"
        assert row.date_of_birth.startswith("enc::")
        assert row.date_of_birth != "1990-01-02"

        loaded = await session.get(User, user_id)
        assert loaded is not None
        assert loaded.phone == "+821012345678"
        assert loaded.date_of_birth == date(1990, 1, 2)


@pytest.mark.asyncio
async def test_user_pii_reads_legacy_plaintext_after_encryption_enabled(client, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY", "")
    reset_pii_fernet_cache()

    user_id = uuid4()
    async with TestSession() as session:
        user = User(
            id=user_id,
            email="pii-legacy@example.com",
            hashed_password="hashed",
            name="Legacy User",
            phone="+821055566677",
            date_of_birth=date(1988, 8, 8),
        )
        session.add(user)
        await session.commit()

    monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY", Fernet.generate_key().decode())
    reset_pii_fernet_cache()

    async with TestSession() as session:
        loaded = await session.get(User, user_id)
        assert loaded is not None
        assert loaded.phone == "+821055566677"
        assert loaded.date_of_birth == date(1988, 8, 8)


def test_production_requires_pii_encryption_key(monkeypatch):
    env = {
        "ENVIRONMENT": "production",
        "SECRET_KEY": "x" * 40,
        # AUDIT 2026-04-20 §25 P0 — distinct secrets required in production.
        "JWT_SECRET": "j" * 40,
        "QR_HMAC_SECRET": "q" * 40,
        "RESET_TOKEN_SECRET": "r" * 40,
        "DB_REQUIRE_SSL": "true",
        "PORTONE_API_SECRET": "portone-secret",
        "PORTONE_WEBHOOK_SECRET": "portone-webhook-secret",
        "PORTONE_MOCK_MODE": "false",
        "PORTONE_WEBHOOK_REQUIRE_TIMESTAMP": "true",
        "PAYMENT_MANUAL_API_ENABLED": "false",
        "REFRESH_COOKIE_SECURE": "true",
        "REFRESH_COOKIE_NAME": "__Host-pickket_refresh",
        "REFRESH_COOKIE_PATH": "/",
        "REFRESH_COOKIE_DOMAIN": "",
        "CORS_ORIGINS": "https://pickket.kr,https://go.pickket.kr,https://admin.pickket.kr",
        "PAYMENT_SUCCESS_URL": "https://pickket.kr/payment/success",
        "PAYMENT_FAIL_URL": "https://pickket.kr/payment/fail",
        "IDENTITY_PROVIDER": "none",
        "EMAIL_PROVIDER": "ses",
        "SMS_PROVIDER": "none",
        "UPLOAD_PROVIDER": "s3",
        "S3_BUCKET": "pickket-uploads",
        "S3_SECRET_KEY": "test-s3-secret-key",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    with pytest.raises(ValueError, match="PII_ENCRYPTION_KEY"):
        Settings(_env_file=None)


def test_phone_lookup_digest_is_keyed_normalized_and_rotation_safe(monkeypatch):
    old_key = Fernet.generate_key().decode()
    new_key = Fernet.generate_key().decode()

    monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY", old_key)
    monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY_PREVIOUS", "")
    old_digest = phone_lookup_digest("010-1234-5678")

    assert old_digest is not None
    assert old_digest == phone_lookup_digest("01012345678")

    monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY", new_key)
    monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY_PREVIOUS", old_key)
    new_digest = phone_lookup_digest("01012345678")
    accepted = phone_lookup_digests("010 1234 5678")

    assert new_digest is not None
    assert new_digest != old_digest
    assert accepted == (new_digest, old_digest)
