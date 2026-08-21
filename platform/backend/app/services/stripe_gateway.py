"""Stripe payment gateway implementation."""

import logging
from decimal import Decimal

import stripe

from app.core.config import settings
from app.services.payment_gateway import PaymentGateway, PaymentResult, RefundResult

logger = logging.getLogger(__name__)

# Zero-decimal currencies where amount is already in the smallest unit
ZERO_DECIMAL_CURRENCIES = {"BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW",
                           "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF",
                           "XOF", "XPF"}


def _to_stripe_amount(amount: Decimal, currency: str) -> int:
    """Convert amount to Stripe's smallest currency unit."""
    if currency.upper() in ZERO_DECIMAL_CURRENCIES:
        return int(amount)
    return int(amount * 100)


class StripeGateway(PaymentGateway):
    """Stripe gateway for international payments.

    Requires STRIPE_SECRET_KEY in environment.
    """

    def __init__(self) -> None:
        if not settings.STRIPE_SECRET_KEY:
            logger.warning("STRIPE_SECRET_KEY not configured — Stripe payments will fail")

    async def create_payment(
        self, order_id: str, amount: Decimal, currency: str, **kwargs
    ) -> PaymentResult:
        if not settings.STRIPE_SECRET_KEY:
            return PaymentResult(
                success=False,
                error="Stripe is not configured. International payments are currently unavailable.",
            )

        try:
            intent = stripe.PaymentIntent.create(
                amount=_to_stripe_amount(amount, currency),
                currency=currency.lower(),
                metadata={"order_id": order_id},
                automatic_payment_methods={"enabled": True},
                api_key=settings.STRIPE_SECRET_KEY,
            )
            return PaymentResult(
                success=True,
                payment_id=intent.id,
                gateway="stripe",
                currency=currency,
                amount=amount,
                redirect_url=None,
                client_secret=intent.client_secret,
            )
        except stripe.StripeError as e:
            logger.error("Stripe create_payment failed: %s", e)
            return PaymentResult(success=False, error=str(e), gateway="stripe")

    async def confirm_payment(self, payment_id: str) -> PaymentResult:
        if not settings.STRIPE_SECRET_KEY:
            return PaymentResult(success=False, error="Stripe not configured")

        try:
            intent = stripe.PaymentIntent.retrieve(
                payment_id,
                api_key=settings.STRIPE_SECRET_KEY,
            )
            if intent.status == "succeeded":
                return PaymentResult(
                    success=True,
                    payment_id=intent.id,
                    gateway="stripe",
                    amount=Decimal(str(intent.amount)),
                )
            return PaymentResult(
                success=False,
                payment_id=intent.id,
                gateway="stripe",
                error=f"Payment status: {intent.status}",
            )
        except stripe.StripeError as e:
            logger.error("Stripe confirm_payment failed: %s", e)
            return PaymentResult(success=False, error=str(e), gateway="stripe")

    async def refund(
        self, payment_id: str, amount: Decimal | None = None, reason: str = ""
    ) -> RefundResult:
        if not settings.STRIPE_SECRET_KEY:
            return RefundResult(success=False, error="Stripe not configured")

        try:
            params: dict = {"payment_intent": payment_id, "api_key": settings.STRIPE_SECRET_KEY}
            if amount is not None:
                # Detect currency from the original payment to convert amount correctly
                intent = stripe.PaymentIntent.retrieve(payment_id, api_key=settings.STRIPE_SECRET_KEY)
                params["amount"] = _to_stripe_amount(amount, intent.currency)
            if reason:
                params["reason"] = "requested_by_customer"
                params["metadata"] = {"reason": reason[:500]}

            refund = stripe.Refund.create(**params)
            return RefundResult(
                success=True,
                refund_id=refund.id,
                amount=amount or Decimal("0"),
            )
        except stripe.StripeError as e:
            logger.error("Stripe refund failed: %s", e)
            return RefundResult(success=False, error=str(e))
