"""Shared NICE payment-attempt fault harness.

This module deliberately keeps provider state by TID.  A one-shot
``AsyncMock(return_value=...)`` cannot represent an approval whose response is
lost and which is later observed as paid by inquiry (F06/F10), nor two TIDs for
the same Moid with different outcomes (F14/F15).

It contains no production-code assertions.  Scenario tests must call the real
service/task entry point and use these objects only at the PG and side-effect
boundaries.
"""

from __future__ import annotations

import asyncio
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum
from typing import Any, Iterable

from app.services.payment_gateway import PaymentVerificationResult


class PGState(StrEnum):
    """Provider-side state retained independently for every TID."""

    NOT_FOUND = "not_found"
    READY = "ready"
    PAID = "paid"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


class PGFault(StrEnum):
    """Transport faults which must never be collapsed into NOT_FOUND."""

    TIMEOUT = "timeout"
    UNAVAILABLE = "unavailable"
    MALFORMED = "malformed"


@dataclass(slots=True)
class PGTransaction:
    tid: str
    moid: str
    amount: Decimal
    state: PGState = PGState.NOT_FOUND
    approve_script: deque[PGState | PGFault] = field(default_factory=deque)
    inquiry_script: deque[PGState | PGFault] = field(default_factory=deque)


class StatefulNicepayFake:
    """Stateful, TID-addressed fake for F06/F10/F14/F15.

    ``approve_script`` and ``inquiry_script`` are consumed from the left.  The
    last resulting provider state remains durable in the fake.  In particular,
    ``approve(..., PAID, TIMEOUT)`` means the provider captured the card but the
    caller lost the acknowledgement; a later inquiry still observes PAID.
    """

    provider_name = "nicepay"

    def __init__(self) -> None:
        self.transactions: dict[str, PGTransaction] = {}
        self.calls: Counter[str] = Counter()
        self.calls_by_tid: dict[str, Counter[str]] = defaultdict(Counter)

    def register(
        self,
        *,
        tid: str,
        moid: str,
        amount: int | float | Decimal,
        state: PGState = PGState.NOT_FOUND,
        approve: Iterable[PGState | PGFault] = (),
        inquiry: Iterable[PGState | PGFault] = (),
    ) -> PGTransaction:
        if tid in self.transactions:
            raise ValueError(f"duplicate fake TID: {tid}")
        tx = PGTransaction(
            tid=tid,
            moid=moid,
            amount=Decimal(str(amount)),
            state=state,
            approve_script=deque(approve),
            inquiry_script=deque(inquiry),
        )
        self.transactions[tid] = tx
        return tx

    def _tx(self, tid: str) -> PGTransaction:
        try:
            return self.transactions[tid]
        except KeyError as exc:
            raise AssertionError(f"unregistered TID reached PG fake: {tid}") from exc

    @staticmethod
    def _raise_fault(outcome: PGState | PGFault) -> None:
        if outcome == PGFault.TIMEOUT:
            raise TimeoutError("NICE fake: response lost after provider operation")
        if outcome == PGFault.UNAVAILABLE:
            raise ConnectionError("NICE fake: provider unavailable")
        if outcome == PGFault.MALFORMED:
            raise ValueError("NICE fake: malformed provider response")

    def approve(
        self,
        tid: str,
        *,
        provider_state_before_fault: PGState | None = None,
    ) -> PGTransaction:
        tx = self._tx(tid)
        self.calls["approve"] += 1
        self.calls_by_tid[tid]["approve"] += 1
        outcome: PGState | PGFault = (
            tx.approve_script.popleft() if tx.approve_script else PGState.PAID
        )
        if isinstance(outcome, PGFault):
            if provider_state_before_fault is not None:
                tx.state = provider_state_before_fault
            self._raise_fault(outcome)
        tx.state = outcome
        return tx

    def inquire(self, tid: str) -> PGTransaction:
        tx = self._tx(tid)
        self.calls["inquire"] += 1
        self.calls_by_tid[tid]["inquire"] += 1
        outcome: PGState | PGFault = (
            tx.inquiry_script.popleft() if tx.inquiry_script else tx.state
        )
        if isinstance(outcome, PGFault):
            self._raise_fault(outcome)
        tx.state = outcome
        return tx

    def cancel(self, tid: str) -> PGTransaction:
        tx = self._tx(tid)
        self.calls["cancel"] += 1
        self.calls_by_tid[tid]["cancel"] += 1
        if tx.state != PGState.PAID:
            raise AssertionError(f"cannot cancel non-paid fake transaction: {tid}={tx.state}")
        tx.state = PGState.CANCELLED
        return tx

    async def verify_payment(
        self,
        *,
        payment_id: str,
        transaction_id: str,
        expected_amount: float,
        currency: str,
        **_: Any,
    ) -> PaymentVerificationResult:
        tx = self._tx(transaction_id)
        if tx.moid != payment_id:
            raise ValueError("NICE fake: Moid mismatch")
        if tx.amount != Decimal(str(expected_amount)):
            raise ValueError("NICE fake: amount mismatch")
        tx = self.approve(transaction_id)
        if tx.state not in (PGState.PAID, PGState.READY):
            raise ValueError(f"NICE fake: approval status={tx.state}")
        raw: dict[str, Any] = {
            "ResultCode": "3001" if tx.state == PGState.PAID else "4100",
            "Moid": tx.moid,
            "TID": tx.tid,
            "Amt": str(tx.amount),
            "status": tx.state.value,
        }
        if tx.state == PGState.READY:
            raw.update({"_pending": True, "_normalized_status": "authorized"})
        return PaymentVerificationResult(
            provider="nicepay",
            payment_id=tx.moid,
            transaction_id=tx.tid,
            amount=float(tx.amount),
            currency=currency,
            raw=raw,
        )

    async def fetch_payment_by_order_id(
        self, order_id: str, *, transaction_id: str | None = None
    ) -> dict[str, Any] | None:
        if not transaction_id:
            raise AssertionError("NICE inquiry requires TID; Moid-only lookup is forbidden")
        tx = self.inquire(transaction_id)
        if tx.moid != order_id:
            return {
                "ResultCode": "0000",
                "TID": tx.tid,
                "Moid": tx.moid,
                "Amt": str(tx.amount),
                "Status": "0" if tx.state == PGState.PAID else tx.state.value,
            }
        if tx.state == PGState.NOT_FOUND:
            return None
        return {
            "ResultCode": "0000",
            "TID": tx.tid,
            "Moid": tx.moid,
            "Amt": str(tx.amount),
            "Status": "0" if tx.state == PGState.PAID else tx.state.value,
        }


class SideEffectCounter:
    """Counts externally visible effects, not merely final DB state."""

    REQUIRED = ("audit", "points", "notification", "go_propagation")

    def __init__(self) -> None:
        self.counts: Counter[str] = Counter()
        self.payloads: dict[str, list[Any]] = defaultdict(list)

    def record(self, effect: str, payload: Any = None) -> None:
        self.counts[effect] += 1
        self.payloads[effect].append(payload)

    async def audit(self, *args: Any, **kwargs: Any) -> None:
        self.record("audit", (args, kwargs))

    async def points(self, *args: Any, **kwargs: Any) -> None:
        self.record("points", (args, kwargs))

    async def notification(self, *args: Any, **kwargs: Any) -> None:
        self.record("notification", (args, kwargs))

    def go_propagation(self, payload: Any = None) -> None:
        self.record("go_propagation", payload)

    def assert_exactly(self, **expected: int) -> None:
        missing = set(expected) - set(self.REQUIRED)
        if missing:
            raise AssertionError(f"unknown side effects: {sorted(missing)}")
        actual = {key: self.counts[key] for key in expected}
        if actual != expected:
            raise AssertionError(f"side-effect count mismatch: {actual} != {expected}")


class AsyncBarrier:
    """Reusable barrier that proves coroutines actually overlap."""

    def __init__(self, parties: int) -> None:
        if parties < 2:
            raise ValueError("barrier needs at least two parties")
        self.parties = parties
        self.arrived = 0
        self.generation = 0
        self._condition = asyncio.Condition()

    async def wait(self, timeout: float = 5.0) -> None:
        async def _wait() -> None:
            async with self._condition:
                generation = self.generation
                self.arrived += 1
                if self.arrived == self.parties:
                    self.arrived = 0
                    self.generation += 1
                    self._condition.notify_all()
                    return
                await self._condition.wait_for(lambda: self.generation != generation)

        await asyncio.wait_for(_wait(), timeout=timeout)
