"""Exchange rate service for currency conversion."""

from datetime import date
from decimal import Decimal
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.exchange_rate import ExchangeRate

# Fallback rates (updated periodically, used when DB has no data)
FALLBACK_RATES: dict[str, float] = {
    "USD": 1.0,
    "KRW": 1350.0,
    "JPY": 150.0,
    "EUR": 0.92,
    "GBP": 0.79,
    "CNY": 7.25,
    "THB": 35.5,
    "SGD": 1.35,
    "AUD": 1.55,
    "CAD": 1.37,
}


class ExchangeRateService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_rate(
        self, from_currency: str, to_currency: str, on_date: date | None = None
    ) -> Decimal:
        if from_currency == to_currency:
            return Decimal("1.0")

        target_date = on_date or date.today()
        result = await self.db.execute(
            select(ExchangeRate).where(
                and_(
                    ExchangeRate.base_currency == from_currency,
                    ExchangeRate.target_currency == to_currency,
                    ExchangeRate.rate_date == target_date,
                )
            )
        )
        rate_entry = result.scalar_one_or_none()
        if rate_entry:
            return Decimal(str(rate_entry.rate))

        # Fallback: cross-rate via USD
        from_usd = FALLBACK_RATES.get(from_currency, 1.0)
        to_usd = FALLBACK_RATES.get(to_currency, 1.0)
        if from_usd and to_usd:
            return Decimal(str(to_usd / from_usd))
        return Decimal("1.0")

    async def convert(self, amount: Decimal, from_currency: str, to_currency: str) -> Decimal:
        rate = await self.get_rate(from_currency, to_currency)
        return (amount * rate).quantize(Decimal("0.01"))

    async def get_supported_currencies(self) -> list[str]:
        return list(FALLBACK_RATES.keys())
