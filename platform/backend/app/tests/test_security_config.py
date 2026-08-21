"""Security configuration validation tests for production deployments."""

import pytest

from app.core.config import Settings


def _prod_env_overrides() -> dict[str, str]:
    return {
        "ENVIRONMENT": "production",
        "SECRET_KEY": "x" * 40,
        # AUDIT 2026-04-20 §25 P0: require distinct secrets per domain.
        "JWT_SECRET": "j" * 40,
        "QR_HMAC_SECRET": "q" * 40,
        "RESET_TOKEN_SECRET": "r" * 40,
        "DB_REQUIRE_SSL": "true",
        "PORTONE_API_SECRET": "portone-secret",
        "PORTONE_WEBHOOK_SECRET": "portone-webhook-secret",
        "PORTONE_MOCK_MODE": "false",
        "PORTONE_WEBHOOK_REQUIRE_TIMESTAMP": "true",
        # 이 baseline 은 **토스 기준** 프로덕션 설정이다(TOSS 키를 싣는다).
        # 2026-07-28 기본 provider 가 nicepay 로 바뀌었으므로 **명시 고정**한다 —
        # 고정하지 않으면 baseline 이 nicepay 로 해석돼 NICE_MID/MERCHANT_KEY 를 요구한다.
        # 나이스(구형) 프로덕션 유효성은 별도 테스트가 이미 덮는다(G10 · A3 케이스).
        "PAYMENT_PROVIDER": "toss",
        "TOSS_SECRET_KEY": "toss-secret",
        "TOSS_MOCK_MODE": "false",
        "PAYMENT_MANUAL_API_ENABLED": "false",
        "PII_ENCRYPTION_KEY": "R6PVxQXfN7aElE0xv5A_4oQFfF4S1GJ8V7wcL1Ns2dQ=",
        "BILLING_KEY_ENCRYPTION_KEY": "R6PVxQXfN7aElE0xv5A_4oQFfF4S1GJ8V7wcL1Ns2dQ=",
        "REFRESH_COOKIE_SECURE": "true",
        "ACCESS_COOKIE_NAME": "pickket_access",
        "REFRESH_COOKIE_NAME": "pickket_refresh",
        "REFRESH_COOKIE_PATH": "/",
        "REFRESH_COOKIE_DOMAIN": ".pickket.kr",
        "REFRESH_COOKIE_SAMESITE": "lax",
        "CORS_ORIGINS": "https://pickket.kr,https://go.pickket.kr,https://admin.pickket.kr",
        "PAYMENT_SUCCESS_URL": "https://pickket.kr/payment/success",
        "PAYMENT_FAIL_URL": "https://pickket.kr/payment/fail",
        "IDENTITY_PROVIDER": "kisa",
        "EMAIL_PROVIDER": "ses",
        "SMS_PROVIDER": "ncp",
        "UPLOAD_PROVIDER": "s3",
        "S3_BUCKET": "pickket-uploads",
        "S3_SECRET_KEY": "test-s3-secret-key",
        "TRUSTED_PROXY_CIDRS": "127.0.0.1/32,::1/128,10.0.1.0/24,172.31.0.0/16",
        "ADMIN_MFA_REQUIRED": "true",
        # S-1/S-5 (#23/#24): inter-service 보안 경계.
        "GO_WEBHOOK_SECRET": "g" * 40,
        "INTERNAL_COMMERCE_REQUIRE_HMAC": "true",
        "INTERNAL_SERVICE_TOKEN": "t" * 40,  # GO_WEBHOOK_SECRET 과 분리된 평문 토큰
    }


# 🔴 production 보안검증을 **실제 PG 구성에서도** 돌리기 위한 축 (지시서 #8 T19-b).
#
# 배경: 구형 전환으로 NICE_MERCHANT_KEY 가 production 필수가 됐는데 Settings 검증은
#   fail-fast 라, 그 에러가 먼저 발화하면 **뒤의 보안검증이 전부 가려진다**.
#   baseline 을 toss 로 고정하면 테스트는 통과하지만 검증되는 건 "toss 구성" 뿐이다.
#   실제 prod 는 nicepay 다 — 실키를 넣는 순간 이 검증들이 무엇을 지키고 있었는지
#   아무도 모르는 상태로 켜진다. 그래서 **양쪽 구성에서 같은 검증을 돌린다.**
_PROVIDER_KEYSETS: dict[str, dict[str, str]] = {
    "toss": {
        "PAYMENT_PROVIDER": "toss",
        "TOSS_SECRET_KEY": "toss-secret",
        "TOSS_MOCK_MODE": "false",
    },
    "nicepay": {
        "PAYMENT_PROVIDER": "nicepay",
        "NICE_MID": "nicepay-mid",
        "NICE_MERCHANT_KEY": "nicepay-merchant-key",
        "NICEPAY_MOCK_MODE": "false",
        "NICEPAY_RETURN_URL": "https://api.pickket.kr/api/v1/payments/nice/return",
        "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
        "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
        # 질의 #11: go 착지 URL 도 nicepay 필수값 — 없으면 go 주문이 consumer 로 착지한다.
        "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
        "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
    },
}
PAYMENT_PROVIDER_MATRIX = pytest.mark.parametrize("pg_provider", sorted(_PROVIDER_KEYSETS))
_PG_ENV_KEYS = (
    "TOSS_SECRET_KEY", "TOSS_MOCK_MODE",
    "NICE_MID", "NICE_MERCHANT_KEY", "NICEPAY_MOCK_MODE", "NICEPAY_RETURN_URL",
    "NICEPAY_GO_SUCCESS_URL", "NICEPAY_GO_FAIL_URL",
)


def _make_settings_with_env(
    monkeypatch: pytest.MonkeyPatch,
    overrides: dict[str, str],
    pg_provider: str = "toss",
) -> Settings:
    for key, value in _prod_env_overrides().items():
        monkeypatch.setenv(key, value)
    # PG 자격 세트를 통째로 교체 — baseline 의 다른 PG 키가 남아 판정을 흐리지 않게.
    for key in _PG_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    for key, value in _PROVIDER_KEYSETS[pg_provider].items():
        monkeypatch.setenv(key, value)
    for key, value in overrides.items():
        monkeypatch.setenv(key, value)
    return Settings(_env_file=None)


@PAYMENT_PROVIDER_MATRIX
def test_production_requires_pickket_kr_domain_for_refresh_cookie(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    """ADR-006 (개정 2026-04-09): Domain=.pickket.kr 필수 (consumer↔api 공유)."""
    with pytest.raises(ValueError, match="REFRESH_COOKIE_DOMAIN"):
        _make_settings_with_env(
            monkeypatch,
            {"REFRESH_COOKIE_DOMAIN": ""},
            pg_provider=pg_provider,
        )


@PAYMENT_PROVIDER_MATRIX
def test_production_rejects_invalid_samesite_value(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    """ADR-006 (개정): SameSite=None 금지 (CSRF 방어 필수)."""
    with pytest.raises(ValueError, match="REFRESH_COOKIE_SAMESITE"):
        _make_settings_with_env(
            monkeypatch,
            {"REFRESH_COOKIE_SAMESITE": "none"},
            pg_provider=pg_provider,
        )


@PAYMENT_PROVIDER_MATRIX
def test_production_rejects_non_https_cors_origin(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    with pytest.raises(ValueError, match="https://"):
        _make_settings_with_env(
            monkeypatch,
            {"CORS_ORIGINS": "http://localhost:3000"},
            pg_provider=pg_provider,
        )


@PAYMENT_PROVIDER_MATRIX
def test_production_requires_db_ssl(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    with pytest.raises(ValueError, match="DB_REQUIRE_SSL"):
        _make_settings_with_env(monkeypatch, {"DB_REQUIRE_SSL": "false"}, pg_provider=pg_provider)


@PAYMENT_PROVIDER_MATRIX
def test_production_rejects_insecure_redis_tls(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    with pytest.raises(ValueError, match="REDIS_TLS_INSECURE_SKIP_VERIFY"):
        _make_settings_with_env(
            monkeypatch,
            {
                "REDIS_URL": "rediss://cache.pickket.kr:6379/0",
                "REDIS_TLS_INSECURE_SKIP_VERIFY": "true",
            },
            pg_provider=pg_provider,
        )


@PAYMENT_PROVIDER_MATRIX
def test_production_secure_cookie_profile_is_valid(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    """ADR-006 (개정 2026-04-09): Lax + Domain=.pickket.kr + Secure."""
    settings = _make_settings_with_env(monkeypatch, {}, pg_provider=pg_provider)
    assert settings.ENVIRONMENT == "production"
    assert settings.REFRESH_COOKIE_DOMAIN == ".pickket.kr"
    assert settings.REFRESH_COOKIE_SAMESITE.lower() == "lax"
    assert settings.REFRESH_COOKIE_SECURE is True


@PAYMENT_PROVIDER_MATRIX
def test_production_allows_explicitly_disabled_identity_and_sms(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    settings = _make_settings_with_env(
        monkeypatch,
        {
            "IDENTITY_PROVIDER": "none",
            "SMS_PROVIDER": "none",
        },
        pg_provider=pg_provider,
    )
    assert settings.IDENTITY_PROVIDER == "none"
    assert settings.SMS_PROVIDER == "none"


@PAYMENT_PROVIDER_MATRIX
def test_production_rejects_stub_identity_provider_with_actionable_message(pg_provider: str, monkeypatch: pytest.MonkeyPatch,):
    with pytest.raises(ValueError, match="Use 'none'"):
        _make_settings_with_env(monkeypatch, {"IDENTITY_PROVIDER": "stub"}, pg_provider=pg_provider)


@PAYMENT_PROVIDER_MATRIX
def test_production_rejects_stub_sms_provider_with_actionable_message(pg_provider: str, monkeypatch: pytest.MonkeyPatch,):
    with pytest.raises(ValueError, match="Use 'none'"):
        _make_settings_with_env(monkeypatch, {"SMS_PROVIDER": "stub"}, pg_provider=pg_provider)


@PAYMENT_PROVIDER_MATRIX
def test_production_requires_billing_key_encryption_key(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    """M-1: 빌링키 암호화 키 미설정 시 production 기동 거부 (평문 폴백 차단)."""
    with pytest.raises(ValueError, match="BILLING_KEY_ENCRYPTION_KEY"):
        _make_settings_with_env(monkeypatch, {"BILLING_KEY_ENCRYPTION_KEY": ""}, pg_provider=pg_provider)


# ── Staging validation (production parity for billing-key encryption) ──


def _staging_env_overrides() -> dict[str, str]:
    """Staging 검증 블록을 만족하는 최소 환경 (BILLING_KEY 포함)."""
    return {
        "ENVIRONMENT": "staging",
        # 2026-07-28 기본 provider 가 nicepay 로 바뀌었다. 이 baseline 은 나이스 가드를
        # 검증하려는 게 아니므로 provider 를 명시 고정한다(나이스 케이스는 전용 baseline 사용).
        "PAYMENT_PROVIDER": "toss",
        "SECRET_KEY": "x" * 40,
        "GO_WEBHOOK_SECRET": "go-webhook-secret",
        "PORTONE_WEBHOOK_SECRET": "portone-webhook-secret",
        "PORTONE_MOCK_MODE": "false",
        "PII_ENCRYPTION_KEY": "R6PVxQXfN7aElE0xv5A_4oQFfF4S1GJ8V7wcL1Ns2dQ=",
        "BILLING_KEY_ENCRYPTION_KEY": "R6PVxQXfN7aElE0xv5A_4oQFfF4S1GJ8V7wcL1Ns2dQ=",
        "DATABASE_URL": "postgresql+asyncpg://x:x@localhost/x",
    }


def _make_staging_settings(monkeypatch: pytest.MonkeyPatch, overrides: dict[str, str]) -> Settings:
    for key, value in _staging_env_overrides().items():
        monkeypatch.setenv(key, value)
    for key, value in overrides.items():
        monkeypatch.setenv(key, value)
    return Settings(_env_file=None)


def test_staging_requires_billing_key_encryption_key(monkeypatch: pytest.MonkeyPatch):
    """M-1: 빌링키 암호화 키 미설정 시 staging 기동 거부 (평문 폴백 차단)."""
    with pytest.raises(ValueError, match="BILLING_KEY_ENCRYPTION_KEY"):
        _make_staging_settings(monkeypatch, {"BILLING_KEY_ENCRYPTION_KEY": ""})


def test_staging_with_billing_key_is_valid(monkeypatch: pytest.MonkeyPatch):
    """필수 키가 모두 설정되면 staging 설정이 유효하다."""
    settings = _make_staging_settings(monkeypatch, {})
    assert settings.ENVIRONMENT == "staging"
    assert settings.BILLING_KEY_ENCRYPTION_KEY


def test_staging_aliases_resolve_to_staging(monkeypatch: pytest.MonkeyPatch):
    """stg/v2 alias도 staging으로 정규화되어 동일 검증을 받는다."""
    for alias in ("stg", "v2", "stage"):
        with pytest.raises(ValueError, match="BILLING_KEY_ENCRYPTION_KEY"):
            _make_staging_settings(
                monkeypatch,
                {"ENVIRONMENT": alias, "BILLING_KEY_ENCRYPTION_KEY": ""},
            )


# ── A3: staging 나이스 가드 (production parity — prod 는 ENVIRONMENT=staging 운영) ──


def _staging_nicepay_overrides() -> dict[str, str]:
    """staging + 나이스 활성 유효 최소 환경."""
    return {
        "PAYMENT_PROVIDER": "nicepay",
        "NICE_MID": "nicepay-mid",
        "NICE_MERCHANT_KEY": "nicepay-merchant-key",
        "NICEPAY_MOCK_MODE": "false",
        "NICEPAY_RETURN_URL": "https://api.pickket.kr/api/v1/payments/nice/return",
        "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
        "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
    }


def test_staging_nicepay_valid_with_keys(monkeypatch: pytest.MonkeyPatch):
    """A3: staging + 나이스 실키 + mock off + ReturnURL → 유효."""
    settings = _make_staging_settings(monkeypatch, _staging_nicepay_overrides())
    assert settings.PAYMENT_PROVIDER == "nicepay"
    assert settings.NICEPAY_MOCK_MODE is False


def test_staging_nicepay_requires_merchant_key(monkeypatch: pytest.MonkeyPatch):
    """A3: staging + 나이스 활성인데 MerchantKey 없음 → 기동 거부(무가드 실결제 방지)."""
    ov = _staging_nicepay_overrides()
    ov["NICE_MERCHANT_KEY"] = ""
    with pytest.raises(ValueError, match="NICE_MERCHANT_KEY"):
        _make_staging_settings(monkeypatch, ov)


def test_staging_nicepay_requires_mid(monkeypatch: pytest.MonkeyPatch):
    """A3: staging + 나이스 활성인데 MID 없음 → 기동 거부."""
    ov = _staging_nicepay_overrides()
    ov["NICE_MID"] = ""
    with pytest.raises(ValueError, match="NICE_MID"):
        _make_staging_settings(monkeypatch, ov)


def test_staging_nicepay_rejects_mock_mode(monkeypatch: pytest.MonkeyPatch):
    """A3: staging + 나이스 활성인데 MOCK on → 기동 거부(조용한 mock 실결제 차단)."""
    ov = _staging_nicepay_overrides()
    ov["NICEPAY_MOCK_MODE"] = "true"
    with pytest.raises(ValueError, match="NICEPAY_MOCK_MODE"):
        _make_staging_settings(monkeypatch, ov)


def test_staging_nicepay_requires_return_url(monkeypatch: pytest.MonkeyPatch):
    """A3: staging + 나이스 활성인데 ReturnURL 없음 → 기동 거부."""
    ov = _staging_nicepay_overrides()
    ov["NICEPAY_RETURN_URL"] = ""
    with pytest.raises(ValueError, match="NICEPAY_RETURN_URL"):
        _make_staging_settings(monkeypatch, ov)


def test_staging_nicepay_rejects_http_return_url(monkeypatch: pytest.MonkeyPatch):
    """A3: staging + 나이스 활성 ReturnURL 이 http → 기동 거부(https 강제)."""
    ov = _staging_nicepay_overrides()
    ov["NICEPAY_RETURN_URL"] = "http://api.pickket.kr/api/v1/payments/nice/return"
    with pytest.raises(ValueError, match="NICEPAY_RETURN_URL"):
        _make_staging_settings(monkeypatch, ov)


def test_staging_toss_provider_ignores_nicepay_guard(monkeypatch: pytest.MonkeyPatch):
    """A3: PAYMENT_PROVIDER≠nicepay(현 toss 운영)면 나이스 실키 없어도 staging 유효(무영향)."""
    # 기본 staging(_staging_env_overrides)은 provider 미지정 → 기본 'toss'. 나이스 키 전무.
    settings = _make_staging_settings(monkeypatch, {})
    assert settings.PAYMENT_PROVIDER == "toss"
    assert not settings.NICE_MERCHANT_KEY  # 나이스 가드 미적용


def test_staging_nicepay_case_insensitive_guard(monkeypatch: pytest.MonkeyPatch):
    """A3: PAYMENT_PROVIDER 대소문자/공백 변형도 nicepay 로 정규화돼 가드 적용."""
    ov = _staging_nicepay_overrides()
    ov["PAYMENT_PROVIDER"] = " NICEPAY "
    ov["NICE_MERCHANT_KEY"] = ""
    with pytest.raises(ValueError, match="NICE_MERCHANT_KEY"):
        _make_staging_settings(monkeypatch, ov)


@PAYMENT_PROVIDER_MATRIX
def test_production_rejects_broad_trusted_proxy_cidrs(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    with pytest.raises(ValueError, match="overly broad"):
        _make_settings_with_env(
            monkeypatch,
            {"TRUSTED_PROXY_CIDRS": "127.0.0.1/32,10.0.0.0/8"},
            pg_provider=pg_provider,
        )


# ── S-1 / S-5 inter-service 보안 경계 (#23, #24) ──────────────────────────────


def test_production_nicepay_valid_with_keys(monkeypatch: pytest.MonkeyPatch):
    """G10: PAYMENT_PROVIDER=nicepay + MID/MerchantKey + mock off → 유효(구형)."""
    settings = _make_settings_with_env(
        monkeypatch,
        {
            "PAYMENT_PROVIDER": "nicepay",
            "NICE_MID": "nicepay-mid",
            "NICE_MERCHANT_KEY": "nicepay-merchant-key",
            "NICEPAY_MOCK_MODE": "false",
            "NICEPAY_RETURN_URL": "https://api.pickket.kr/api/v1/payments/nice/return",
            "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
            "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
        },
    )
    assert settings.PAYMENT_PROVIDER == "nicepay"
    assert settings.NICEPAY_MOCK_MODE is False


def test_production_nicepay_requires_secret_key(monkeypatch: pytest.MonkeyPatch):
    """G10: nicepay provider 인데 MerchantKey 미설정 → production 기동거부(구형)."""
    with pytest.raises(ValueError, match="NICE_MERCHANT_KEY"):
        _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "nicepay",
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "",
                "NICEPAY_MOCK_MODE": "false",
            },
        )


def test_production_nicepay_requires_mid(monkeypatch: pytest.MonkeyPatch):
    """G10: nicepay provider 인데 MID 미설정 → production 기동거부(구형)."""
    with pytest.raises(ValueError, match="NICE_MID"):
        _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "nicepay",
                "NICE_MID": "",
                "NICE_MERCHANT_KEY": "nicepay-merchant-key",
                "NICEPAY_MOCK_MODE": "false",
            },
        )


def test_production_nicepay_rejects_mock_mode(monkeypatch: pytest.MonkeyPatch):
    """G3/G10: nicepay provider + MOCK_MODE=true → production 기동거부(백도어 차단)."""
    with pytest.raises(ValueError, match="NICEPAY_MOCK_MODE"):
        _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "nicepay",
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "nicepay-merchant-key",
                "NICEPAY_MOCK_MODE": "true",
            },
        )


def test_production_nicepay_does_not_fall_through_to_portone(monkeypatch: pytest.MonkeyPatch):
    """G10 핵심: nicepay 가 else(PortOne 강제)로 떨어지지 않는다.

    PORTONE_API_SECRET 을 비워도 nicepay 분기라 통과해야 한다(PortOne 검증 미적용).
    """
    settings = _make_settings_with_env(
        monkeypatch,
        {
            "PAYMENT_PROVIDER": "nicepay",
            "NICE_MID": "nicepay-mid",
            "NICE_MERCHANT_KEY": "nicepay-merchant-key",
            "NICEPAY_MOCK_MODE": "false",
            "NICEPAY_RETURN_URL": "https://api.pickket.kr/api/v1/payments/nice/return",
            "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
            "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
            "PORTONE_API_SECRET": "",  # nicepay 라면 이게 비어도 무관해야 함
            "PORTONE_WEBHOOK_SECRET": "",
        },
    )
    assert settings.PAYMENT_PROVIDER == "nicepay"


def test_production_nicepay_provider_normalized_case_insensitive(monkeypatch: pytest.MonkeyPatch):
    """Medium#3: PAYMENT_PROVIDER 대소문자/공백이 config 검증에서 nicepay 로 정규화.

    'NICEPAY'/' Nicepay ' 처럼 표기가 흔들려도 nicepay 분기(MerchantKey 필수)를 타야 하고,
    PortOne else 분기(PORTONE_API_SECRET 필수)로 잘못 떨어지면 안 된다.
    """
    for raw in ("NICEPAY", " nicepay", "Nicepay", "  NICEPAY  "):
        settings = _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": raw,
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "nicepay-merchant-key",
                "NICEPAY_MOCK_MODE": "false",
                "NICEPAY_RETURN_URL": "https://api.pickket.kr/api/v1/payments/nice/return",
                "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
                "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
                "PORTONE_API_SECRET": "",  # nicepay 로 정규화되면 이게 비어도 통과.
                "PORTONE_WEBHOOK_SECRET": "",
            },
        )
        # 원본 문자열은 보존되지만 검증은 정규화 규칙으로 판정됨.
        assert settings.PAYMENT_PROVIDER == raw


def test_production_nicepay_uppercase_still_requires_secret(monkeypatch: pytest.MonkeyPatch):
    """Medium#3: 'NICEPAY'(대문자)도 nicepay 로 정규화돼 MerchantKey 미설정 시 거부."""
    with pytest.raises(ValueError, match="NICE_MERCHANT_KEY"):
        _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "NICEPAY",
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "",
                "NICEPAY_MOCK_MODE": "false",
            },
        )


def test_production_nicepay_rejects_non_nicepay_base_url(monkeypatch: pytest.MonkeyPatch):
    """Low#4 SSRF: NICEPAY_API_BASE_URL 이 나이스 도메인 아니면 production 기동거부."""
    with pytest.raises(ValueError, match="SSRF|nicepay.co.kr"):
        _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "nicepay",
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "nicepay-merchant-key",
                "NICEPAY_MOCK_MODE": "false",
                "NICEPAY_RETURN_URL": "https://api.pickket.kr/api/v1/payments/nice/return",
                "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
                "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
                "NICEPAY_API_BASE_URL": "https://evil.example.com",
            },
        )


def test_production_nicepay_rejects_http_base_url(monkeypatch: pytest.MonkeyPatch):
    """Low#4 SSRF: https 가 아니면(평문 http) 거부."""
    with pytest.raises(ValueError, match="https"):
        _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "nicepay",
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "nicepay-merchant-key",
                "NICEPAY_MOCK_MODE": "false",
                "NICEPAY_RETURN_URL": "https://api.pickket.kr/api/v1/payments/nice/return",
                "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
                "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
                "NICEPAY_API_BASE_URL": "http://api.nicepay.co.kr",
            },
        )


def test_production_nicepay_requires_return_url(monkeypatch: pytest.MonkeyPatch):
    """구형 결제창 ReturnURL(나이스→v2 인증결과 POST 목적지) 미설정 → production 기동거부.

    ReturnURL 이 없으면 나이스가 인증결과를 v2 로 보내지 못해 승인 흐름이 성립하지
    않으므로, MID/MerchantKey/mock off 가 다 맞아도 프로덕션에서는 반드시 요구한다.
    """
    with pytest.raises(ValueError, match="NICEPAY_RETURN_URL"):
        _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "nicepay",
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "nicepay-merchant-key",
                "NICEPAY_MOCK_MODE": "false",
                "NICEPAY_RETURN_URL": "",
                "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
                "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
            },
        )


def test_production_nicepay_rejects_http_return_url(monkeypatch: pytest.MonkeyPatch):
    """ReturnURL 이 https 가 아니면(평문 http) 프로덕션 기동거부."""
    with pytest.raises(ValueError, match="NICEPAY_RETURN_URL.*https"):
        _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "nicepay",
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "nicepay-merchant-key",
                "NICEPAY_MOCK_MODE": "false",
                "NICEPAY_RETURN_URL": "http://api.pickket.kr/api/v1/payments/nice/return",
                "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
                "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
            },
        )


def test_production_nicepay_accepts_official_base_urls(monkeypatch: pytest.MonkeyPatch):
    """Low#4 SSRF: 운영/샌드박스 나이스 도메인은 통과."""
    for url in ("https://webapi.nicepay.co.kr", "https://api.nicepay.co.kr"):
        settings = _make_settings_with_env(
            monkeypatch,
            {
                "PAYMENT_PROVIDER": "nicepay",
                "NICE_MID": "nicepay-mid",
                "NICE_MERCHANT_KEY": "nicepay-merchant-key",
                "NICEPAY_MOCK_MODE": "false",
                "NICEPAY_RETURN_URL": "https://api.pickket.kr/api/v1/payments/nice/return",
                "NICEPAY_GO_SUCCESS_URL": "https://go.pickket.kr/checkout/nice/success",
                "NICEPAY_GO_FAIL_URL": "https://go.pickket.kr/checkout/nice/fail",
                "NICEPAY_API_BASE_URL": url,
            },
        )
        assert settings.NICEPAY_API_BASE_URL == url


@PAYMENT_PROVIDER_MATRIX
def test_production_baseline_is_valid_with_internal_secrets(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    """기본 production 설정(분리 토큰 + HMAC 필수)이 유효하다."""
    settings = _make_settings_with_env(monkeypatch, {}, pg_provider=pg_provider)
    assert settings.INTERNAL_COMMERCE_REQUIRE_HMAC is True
    assert settings.INTERNAL_SERVICE_TOKEN != settings.GO_WEBHOOK_SECRET
    # internal_service_token 은 분리된 토큰을 반환.
    assert settings.internal_service_token == settings.INTERNAL_SERVICE_TOKEN


@PAYMENT_PROVIDER_MATRIX
def test_production_requires_internal_commerce_hmac(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    """#24: production 에서 토큰 폴백(타임스탬프·논스 없는 인증) 강제 차단."""
    with pytest.raises(ValueError, match="INTERNAL_COMMERCE_REQUIRE_HMAC"):
        _make_settings_with_env(
            monkeypatch, {"INTERNAL_COMMERCE_REQUIRE_HMAC": "false"}
        )


@PAYMENT_PROVIDER_MATRIX
def test_production_requires_internal_service_token(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    """#23: 평문 서비스 토큰이 설정되어야 한다."""
    with pytest.raises(ValueError, match="INTERNAL_SERVICE_TOKEN is required"):
        _make_settings_with_env(monkeypatch, {"INTERNAL_SERVICE_TOKEN": ""}, pg_provider=pg_provider)


@PAYMENT_PROVIDER_MATRIX
def test_production_rejects_service_token_equal_to_webhook_secret(pg_provider: str, monkeypatch: pytest.MonkeyPatch,):
    """#23 핵심: 평문 토큰 == HMAC 서명 시크릿이면 헤더 로그 1건으로 시크릿 유출 → 금지."""
    with pytest.raises(ValueError, match="distinct from GO_WEBHOOK_SECRET"):
        _make_settings_with_env(
            monkeypatch,
            {"INTERNAL_SERVICE_TOKEN": "g" * 40},  # GO_WEBHOOK_SECRET 과 동일
            pg_provider=pg_provider,
        )


@PAYMENT_PROVIDER_MATRIX
def test_production_requires_go_webhook_secret(pg_provider: str, monkeypatch: pytest.MonkeyPatch):
    """S-1: go↔v2 서명 시크릿은 production 필수."""
    with pytest.raises(ValueError, match="GO_WEBHOOK_SECRET is required"):
        _make_settings_with_env(monkeypatch, {"GO_WEBHOOK_SECRET": ""}, pg_provider=pg_provider)


def test_internal_service_token_falls_back_to_webhook_secret_in_dev(
    monkeypatch: pytest.MonkeyPatch,
):
    """전환기(dev/staging): INTERNAL_SERVICE_TOKEN 미설정이면 GO_WEBHOOK_SECRET 폴백."""
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("SECRET_KEY", "x" * 40)
    monkeypatch.setenv("GO_WEBHOOK_SECRET", "shared-secret-value")
    settings = Settings(_env_file=None)
    assert settings.INTERNAL_SERVICE_TOKEN == ""
    assert settings.internal_service_token == "shared-secret-value"


# ── 질의 #11: go 착지 URL 필수화 ────────────────────────────────────────────────
# 배경: payment_webhook 이 `NICEPAY_GO_SUCCESS_URL or PAYMENT_SUCCESS_URL` 로 폴백해
#   origin=go 주문을 consumer(www.pickket.kr)로 착지시켰다. KLPGA 처럼
#   sale_channels={self} 인 행사는 consumer 에 노출조차 안 되므로 구매자가
#   **자기 티켓을 볼 수 없는 사이트**에 떨어진다. 페이지는 200 이라 장애로 보이지 않는다.
#   ⟹ 폴백을 제거하고 GO URL 을 NICE 키 4종과 같은 등급의 필수값으로 올렸다.


def test_staging_nicepay_requires_go_success_url(monkeypatch: pytest.MonkeyPatch):
    ov = _staging_nicepay_overrides()
    ov["NICEPAY_GO_FAIL_URL"] = "https://go.pickket.kr/checkout/nice/fail"
    ov["NICEPAY_GO_SUCCESS_URL"] = ""
    with pytest.raises(ValueError, match="NICEPAY_GO_SUCCESS_URL is required"):
        _make_staging_settings(monkeypatch, ov)


def test_staging_nicepay_requires_go_fail_url(monkeypatch: pytest.MonkeyPatch):
    ov = _staging_nicepay_overrides()
    ov["NICEPAY_GO_SUCCESS_URL"] = "https://go.pickket.kr/checkout/nice/success"
    ov["NICEPAY_GO_FAIL_URL"] = ""
    with pytest.raises(ValueError, match="NICEPAY_GO_FAIL_URL is required"):
        _make_staging_settings(monkeypatch, ov)


def test_staging_nicepay_valid_with_go_landing_urls(monkeypatch: pytest.MonkeyPatch):
    """두 URL 이 모두 있으면 유효 — 배포 env 가 이 형태여야 한다."""
    ov = _staging_nicepay_overrides()
    ov["NICEPAY_GO_SUCCESS_URL"] = "https://go.pickket.kr/checkout/nice/success"
    ov["NICEPAY_GO_FAIL_URL"] = "https://go.pickket.kr/checkout/nice/fail"
    settings = _make_staging_settings(monkeypatch, ov)
    assert settings.NICEPAY_GO_SUCCESS_URL.startswith("https://go.pickket.kr")


def test_staging_toss_provider_ignores_go_landing_guard(monkeypatch: pytest.MonkeyPatch):
    """toss 운영이면 go 착지 URL 을 강제하지 않는다(나이스 전용 가드)."""
    ov = _staging_env_overrides()
    ov["PAYMENT_PROVIDER"] = "toss"
    settings = _make_staging_settings(monkeypatch, ov)
    assert settings.PAYMENT_PROVIDER == "toss"


def test_go_origin_never_falls_back_to_consumer(monkeypatch: pytest.MonkeyPatch):
    """🔴 폴백 제거 실증 — GO URL 이 비면 consumer 로 흘리지 않고 **예외**.

    이 단언이 이번 결함의 본질이다. 예전 구현은 조용히
    `settings.PAYMENT_SUCCESS_URL`(= www.pickket.kr)을 돌려줬다.
    """
    from app.api.v1 import payment_webhook
    from app.core.config import settings as live_settings

    monkeypatch.setattr(live_settings, "NICEPAY_GO_SUCCESS_URL", "", raising=False)
    monkeypatch.setattr(live_settings, "NICEPAY_GO_FAIL_URL", "", raising=False)
    monkeypatch.setattr(
        live_settings, "PAYMENT_SUCCESS_URL", "https://www.pickket.kr/payment/success", raising=False
    )
    with pytest.raises(RuntimeError, match="NICEPAY_GO_SUCCESS_URL"):
        payment_webhook._nice_redirect_targets("go")


def test_go_origin_uses_go_landing_when_configured(monkeypatch: pytest.MonkeyPatch):
    """설정돼 있으면 go 랜딩으로 — consumer 로 새지 않는다."""
    from app.api.v1 import payment_webhook
    from app.core.config import settings as live_settings

    monkeypatch.setattr(
        live_settings, "NICEPAY_GO_SUCCESS_URL", "https://go.pickket.kr/checkout/nice/success", raising=False
    )
    monkeypatch.setattr(
        live_settings, "NICEPAY_GO_FAIL_URL", "https://go.pickket.kr/checkout/nice/fail", raising=False
    )
    monkeypatch.setattr(
        live_settings, "PAYMENT_SUCCESS_URL", "https://www.pickket.kr/payment/success", raising=False
    )
    success, fail = payment_webhook._nice_redirect_targets("go")
    assert success == "https://go.pickket.kr/checkout/nice/success"
    assert fail == "https://go.pickket.kr/checkout/nice/fail"
    assert "www.pickket.kr" not in success


def test_consumer_origin_still_uses_consumer_landing(monkeypatch: pytest.MonkeyPatch):
    """consumer origin 은 종전대로 — go 가드가 consumer 경로를 깨지 않는다."""
    from app.api.v1 import payment_webhook
    from app.core.config import settings as live_settings

    monkeypatch.setattr(
        live_settings, "PAYMENT_SUCCESS_URL", "https://www.pickket.kr/payment/success", raising=False
    )
    monkeypatch.setattr(
        live_settings, "PAYMENT_FAIL_URL", "https://www.pickket.kr/payment/fail", raising=False
    )
    success, _ = payment_webhook._nice_redirect_targets("consumer")
    assert success == "https://www.pickket.kr/payment/success"
