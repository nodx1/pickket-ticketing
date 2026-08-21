"""Harness self-tests — NICE-PA-FAULT-v1 F06/F10/F13/F14/F15/F21/F24.

Invariants: I1, I2, I4, I5, I6.

These tests verify that the fake itself can represent the fault sequences the
production scenarios need.  They do *not* count as a production scenario pass.
"""

from __future__ import annotations

import asyncio

import pytest

from app.tests.fault.harness import (
    AsyncBarrier,
    PGFault,
    PGState,
    SideEffectCounter,
    StatefulNicepayFake,
)


def test_f06_timeout_after_capture_remains_paid_for_later_inquiry() -> None:
    pg = StatefulNicepayFake()
    pg.register(
        tid="F06-TID",
        moid="F06-MOID",
        amount=10_000,
        approve=(PGFault.TIMEOUT,),
    )

    with pytest.raises(TimeoutError):
        pg.approve("F06-TID", provider_state_before_fault=PGState.PAID)

    assert pg.inquire("F06-TID").state == PGState.PAID
    assert pg.calls_by_tid["F06-TID"] == {"approve": 1, "inquire": 1}


def test_f10_f14_f15_two_tids_never_overwrite_each_other() -> None:
    pg = StatefulNicepayFake()
    pg.register(tid="TID-A", moid="SAME-MOID", amount=10_000, state=PGState.FAILED)
    pg.register(tid="TID-B", moid="SAME-MOID", amount=10_000, state=PGState.PAID)

    assert pg.inquire("TID-A").state == PGState.FAILED
    assert pg.inquire("TID-B").state == PGState.PAID
    pg.cancel("TID-B")
    assert pg.transactions["TID-A"].state == PGState.FAILED
    assert pg.transactions["TID-B"].state == PGState.CANCELLED


@pytest.mark.asyncio
async def test_f13_f21_f24_barrier_requires_real_overlap() -> None:
    barrier = AsyncBarrier(3)
    reached: list[int] = []

    async def participant(number: int) -> None:
        reached.append(number)
        await barrier.wait()

    await asyncio.gather(*(participant(i) for i in range(3)))
    assert sorted(reached) == [0, 1, 2]


def test_side_effect_counter_enforces_exact_call_counts() -> None:
    effects = SideEffectCounter()
    effects.record("audit")
    effects.record("points")
    effects.record("notification")
    effects.record("go_propagation")
    effects.assert_exactly(audit=1, points=1, notification=1, go_propagation=1)

    effects.record("notification")
    with pytest.raises(AssertionError, match="side-effect count mismatch"):
        effects.assert_exactly(audit=1, points=1, notification=1, go_propagation=1)
