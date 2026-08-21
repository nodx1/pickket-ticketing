"""P3-14: Multi-currency and global payment support.

Handles currency conversion, display formatting, and payment gateway routing:
- Real-time exchange rates (cached in Redis)
- Currency display formatting per locale
- Payment gateway routing based on currency
- Settlement currency management for organizers
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from enum import Enum

import json
from app.core.redis import get_redis


class Currency(str, Enum):
    KRW = "KRW"
    USD = "USD"
    JPY = "JPY"
    EUR = "EUR"
    CNY = "CNY"
    VND = "VND"
    GBP = "GBP"
    THB = "THB"
    SGD = "SGD"


@dataclass
class CurrencyConfig:
    code: Currency
    symbol: str
    name_ko: str
    name_en: str
    decimal_places: int
    min_charge: Decimal  # Minimum charge amount
    formatting: str  # e.g., "{symbol}{amount}" or "{amount}{symbol}"

    def format(self, amount: Decimal) -> str:
        formatted = f"{amount:,.{self.decimal_places}f}"
        return self.formatting.replace("{symbol}", self.symbol).replace("{amount}", formatted)


CURRENCY_CONFIGS: dict[Currency, CurrencyConfig] = {
    Currency.KRW: CurrencyConfig(
        code=Currency.KRW, symbol="₩", name_ko="원", name_en="Korean Won",
        decimal_places=0, min_charge=Decimal("1000"),
        formatting="{symbol}{amount}",
    ),
    Currency.USD: CurrencyConfig(
        code=Currency.USD, symbol="$", name_ko="달러", name_en="US Dollar",
        decimal_places=2, min_charge=Decimal("1.00"),
        formatting="{symbol}{amount}",
    ),
    Currency.JPY: CurrencyConfig(
        code=Currency.JPY, symbol="¥", name_ko="엔", name_en="Japanese Yen",
        decimal_places=0, min_charge=Decimal("100"),
        formatting="{symbol}{amount}",
    ),
    Currency.EUR: CurrencyConfig(
        code=Currency.EUR, symbol="€", name_ko="유로", name_en="Euro",
        decimal_places=2, min_charge=Decimal("1.00"),
        formatting="{symbol}{amount}",
    ),
    Currency.CNY: CurrencyConfig(
        code=Currency.CNY, symbol="¥", name_ko="위안", name_en="Chinese Yuan",
        decimal_places=2, min_charge=Decimal("1.00"),
        formatting="{symbol}{amount}",
    ),
    Currency.VND: CurrencyConfig(
        code=Currency.VND, symbol="₫", name_ko="동", name_en="Vietnamese Dong",
        decimal_places=0, min_charge=Decimal("10000"),
        formatting="{amount}{symbol}",
    ),
    Currency.GBP: CurrencyConfig(
        code=Currency.GBP, symbol="£", name_ko="파운드", name_en="British Pound",
        decimal_places=2, min_charge=Decimal("1.00"),
        formatting="{symbol}{amount}",
    ),
    Currency.THB: CurrencyConfig(
        code=Currency.THB, symbol="฿", name_ko="바트", name_en="Thai Baht",
        decimal_places=2, min_charge=Decimal("20.00"),
        formatting="{symbol}{amount}",
    ),
    Currency.SGD: CurrencyConfig(
        code=Currency.SGD, symbol="S$", name_ko="싱가포르달러", name_en="Singapore Dollar",
        decimal_places=2, min_charge=Decimal("1.00"),
        formatting="{symbol}{amount}",
    ),
}

# Fallback exchange rates (KRW base) — updated via background task
DEFAULT_RATES: dict[str, float] = {
    "KRW": 1.0,
    "USD": 0.00074,
    "JPY": 0.114,
    "EUR": 0.00068,
    "CNY": 0.0054,
    "VND": 18.62,
    "GBP": 0.00058,
    "THB": 0.026,
    "SGD": 0.00099,
}

RATE_CACHE_TTL = 3600  # 1 hour


# ── Exchange Rates ────────────────────────────────────────────────────────────

async def get_exchange_rate(
    from_currency: str,
    to_currency: str,
) -> Decimal:
    """Get exchange rate from one currency to another."""
    if from_currency == to_currency:
        return Decimal("1.0")

    redis = get_redis()
    rate = None

    if redis:
        try:
            cached = await redis.get(f"v2:fx:rate:{from_currency}:{to_currency}")
            if cached:
                raw = cached.decode() if isinstance(cached, bytes) else cached
                return Decimal(raw)
        except Exception:
            pass

    # Calculate from KRW base rates
    from_rate = Decimal(str(DEFAULT_RATES.get(from_currency, 1.0)))
    to_rate = Decimal(str(DEFAULT_RATES.get(to_currency, 1.0)))

    if from_rate == 0:
        return Decimal("0")

    rate = to_rate / from_rate

    # Cache the rate
    if redis:
        try:
            await redis.set(
                f"v2:fx:rate:{from_currency}:{to_currency}",
                str(rate),
                ex=RATE_CACHE_TTL,
            )
        except Exception:
            pass

    return rate


async def convert_amount(
    amount: Decimal,
    from_currency: str,
    to_currency: str,
) -> Decimal:
    """Convert amount from one currency to another."""
    rate = await get_exchange_rate(from_currency, to_currency)
    config = CURRENCY_CONFIGS.get(Currency(to_currency))
    places = config.decimal_places if config else 2

    converted = amount * rate
    quantize_str = "1" if places == 0 else f"0.{'0' * places}"
    return converted.quantize(Decimal(quantize_str), rounding=ROUND_HALF_UP)


async def update_exchange_rates(rates: dict[str, float]) -> bool:
    """Update cached exchange rates (called by background task)."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        # Store rates relative to KRW
        pipe = redis.pipeline()
        for currency, rate in rates.items():
            for target, target_rate in rates.items():
                if currency == target:
                    continue
                if rate == 0:
                    continue
                cross_rate = target_rate / rate
                pipe.set(f"v2:fx:rate:{currency}:{target}", str(cross_rate), ex=RATE_CACHE_TTL)

        pipe.set("v2:fx:updated_at", datetime.now(timezone.utc).isoformat(), ex=RATE_CACHE_TTL)
        await pipe.execute()
        return True
    except Exception:
        return False


# ── Price Display ─────────────────────────────────────────────────────────────

async def format_price(
    amount: Decimal,
    currency: str,
    target_currency: str | None = None,
) -> dict:
    """Format a price for display, optionally with conversion."""
    config = CURRENCY_CONFIGS.get(Currency(currency))
    if not config:
        return {"formatted": f"{amount} {currency}", "amount": str(amount), "currency": currency}

    result = {
        "amount": str(amount),
        "currency": currency,
        "formatted": config.format(amount),
        "symbol": config.symbol,
    }

    if target_currency and target_currency != currency:
        converted = await convert_amount(amount, currency, target_currency)
        target_config = CURRENCY_CONFIGS.get(Currency(target_currency))
        if target_config:
            result["converted"] = {
                "amount": str(converted),
                "currency": target_currency,
                "formatted": target_config.format(converted),
                "symbol": target_config.symbol,
            }

    return result


async def get_prices_multi_currency(
    amount_krw: Decimal,
    currencies: list[str] | None = None,
) -> dict[str, dict]:
    """Get price in multiple currencies from KRW base."""
    if currencies is None:
        currencies = ["KRW", "USD", "JPY", "EUR", "CNY"]

    prices = {}
    for curr in currencies:
        converted = await convert_amount(amount_krw, "KRW", curr)
        config = CURRENCY_CONFIGS.get(Currency(curr))
        if config:
            prices[curr] = {
                "amount": str(converted),
                "formatted": config.format(converted),
                "symbol": config.symbol,
            }

    return prices


# ── Payment Gateway Routing ───────────────────────────────────────────────────

GATEWAY_ROUTING = {
    Currency.KRW: "portone_kr",
    Currency.USD: "stripe",
    Currency.JPY: "stripe",
    Currency.EUR: "stripe",
    Currency.GBP: "stripe",
    Currency.CNY: "alipay",
    Currency.VND: "vnpay",
    Currency.THB: "omise",
    Currency.SGD: "stripe",
}


def get_payment_gateway(currency: str) -> str:
    """Get the payment gateway for a currency."""
    try:
        return GATEWAY_ROUTING.get(Currency(currency), "stripe")
    except ValueError:
        return "stripe"


def get_supported_currencies() -> list[dict]:
    """Get list of supported currencies with their configs."""
    return [
        {
            "code": config.code.value,
            "symbol": config.symbol,
            "name_ko": config.name_ko,
            "name_en": config.name_en,
            "decimal_places": config.decimal_places,
            "gateway": get_payment_gateway(config.code.value),
        }
        for config in CURRENCY_CONFIGS.values()
    ]


# ── Locale Detection ─────────────────────────────────────────────────────────

LOCALE_CURRENCY_MAP = {
    "ko": Currency.KRW,
    "ko-KR": Currency.KRW,
    "en": Currency.USD,
    "en-US": Currency.USD,
    "en-GB": Currency.GBP,
    "ja": Currency.JPY,
    "ja-JP": Currency.JPY,
    "zh": Currency.CNY,
    "zh-CN": Currency.CNY,
    "vi": Currency.VND,
    "vi-VN": Currency.VND,
    "th": Currency.THB,
    "th-TH": Currency.THB,
    "fr": Currency.EUR,
    "de": Currency.EUR,
    "ru": Currency.EUR,
}


def detect_currency_from_locale(locale: str) -> str:
    """Detect preferred currency from user locale."""
    currency = LOCALE_CURRENCY_MAP.get(locale)
    if not currency:
        # Try language only
        lang = locale.split("-")[0] if "-" in locale else locale
        currency = LOCALE_CURRENCY_MAP.get(lang, Currency.KRW)
    return currency.value
