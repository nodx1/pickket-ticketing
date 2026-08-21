"""Tests for Settings validation (C-2 + H-5: staging secret enforcement)."""

import pytest
from pydantic import ValidationError

from app.core.config import Settings


def _base_staging_settings(**overrides):
    """Return minimal valid staging settings dict."""
    defaults = {
        "ENVIRONMENT": "staging",
        # 2026-07-28 기본 provider 가 nicepay 로 바뀌었다. 이 baseline 은 나이스 가드를
        # 검증하려는 게 아니므로 provider 를 명시 고정한다(나이스 케이스는 전용 baseline 사용).
        "PAYMENT_PROVIDER": "toss",
        "SECRET_KEY": "a" * 32,
        "GO_WEBHOOK_SECRET": "test-go-webhook-secret",
        "PORTONE_MOCK_MODE": True,  # bypass PORTONE_WEBHOOK_SECRET requirement
        "PII_ENCRYPTION_KEY": "x" * 44,  # Fernet key placeholder
        "BILLING_KEY_ENCRYPTION_KEY": "y" * 44,  # Fernet key placeholder (staging 필수)
    }
    defaults.update(overrides)
    return defaults


class TestStagingValidation:
    def test_staging_accepts_valid_secrets(self):
        s = Settings(**_base_staging_settings())
        assert s.ENVIRONMENT == "staging"

    def test_staging_rejects_short_secret_key(self):
        with pytest.raises(ValidationError, match="SECRET_KEY must be at least 32 characters"):
            Settings(**_base_staging_settings(SECRET_KEY="short"))

    def test_staging_rejects_empty_secret_key(self):
        with pytest.raises(ValidationError, match="SECRET_KEY must be at least 32 characters"):
            Settings(**_base_staging_settings(SECRET_KEY=""))

    def test_staging_rejects_missing_go_webhook_secret(self):
        with pytest.raises(ValidationError, match="GO_WEBHOOK_SECRET is required"):
            Settings(**_base_staging_settings(GO_WEBHOOK_SECRET=""))

    def test_staging_rejects_missing_portone_secret_when_mock_disabled(self):
        with pytest.raises(ValidationError, match="PORTONE_WEBHOOK_SECRET is required"):
            Settings(**_base_staging_settings(
                PORTONE_MOCK_MODE=False,
                PORTONE_WEBHOOK_SECRET="",
            ))

    def test_staging_accepts_missing_portone_secret_when_mock_enabled(self):
        s = Settings(**_base_staging_settings(
            PORTONE_MOCK_MODE=True,
            PORTONE_WEBHOOK_SECRET="",
        ))
        assert s.PORTONE_MOCK_MODE is True

    def test_staging_rejects_missing_pii_encryption_key(self):
        with pytest.raises(ValidationError, match="PII_ENCRYPTION_KEY is required"):
            Settings(**_base_staging_settings(PII_ENCRYPTION_KEY=""))

    def test_staging_alias_stg_normalized(self):
        s = Settings(**_base_staging_settings(ENVIRONMENT="stg"))
        assert s.ENVIRONMENT == "staging"

    def test_development_skips_staging_checks(self):
        """Development environment should NOT enforce staging secrets."""
        s = Settings(
            ENVIRONMENT="development",
            SECRET_KEY="short",
        )
        assert s.ENVIRONMENT == "development"
