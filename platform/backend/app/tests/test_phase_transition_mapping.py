"""T1-2(F1) 계약 골든: phase_transition (mode×status) → v2 EventStatus 매핑.

스테이징이 없으므로(CapRover 단일 prod) 순수 매핑 함수 골든이 주 검증수단.
resolve_phase_transition_target 는 side-effect 없는 순수함수이므로 전 조합을 고정한다.

핵심 단언:
- fcfs_residual/queue_sale + closed 는 flag OFF 면 gated(무전이), ON 이면 BIDDING_CLOSED.
- 미매핑 조합(waitlist_promotion+open 등)은 조용히 유실되지 않고 outcome=unmapped 로 표시.
"""
import pytest

from app.api.v1.internal_sync import (
    PhaseTransitionOutcome,
    resolve_phase_transition_target,
)
from app.models.event import EventStatus

# go 가 보내는 phase / status 전 조합 (PhaseTransitionPayload docstring 기준)
_PHASES = [
    "membership_presale",
    "lottery",
    "waitlist_promotion",
    "queue_sale",
    "fcfs_residual",
]
_STATUSES = ["open", "closed", "scheduled", "allocating", "allocated", "skipped"]

_MAPPED = "mapped"
_GATED = "gated"
_UNMAPPED = "unmapped"


def _expected(phase: str, status: str, *, fcfs_on: bool):
    """골든 기대값 계산기(핸들러와 독립적으로 재기술 — 회귀 시 양쪽이 함께 틀리지 않도록)."""
    if phase in ("membership_presale", "lottery") and status == "open":
        return (EventStatus.BIDDING_OPEN, _MAPPED)
    if phase in ("membership_presale", "lottery") and status == "closed":
        return (EventStatus.BIDDING_CLOSED, _MAPPED)
    if phase == "fcfs_residual" and status == "open":
        return (EventStatus.BIDDING_OPEN, _MAPPED)
    if phase in ("fcfs_residual", "queue_sale") and status == "closed":
        if fcfs_on:
            return (EventStatus.BIDDING_CLOSED, _MAPPED)
        return (None, _GATED)
    if status == "allocated":
        return (EventStatus.ALLOCATED, _MAPPED)
    return (None, _UNMAPPED)


@pytest.mark.parametrize("fcfs_on", [False, True], ids=["flag_off", "flag_on"])
@pytest.mark.parametrize("phase", _PHASES)
@pytest.mark.parametrize("status", _STATUSES)
def test_phase_transition_golden(phase, status, fcfs_on):
    got = resolve_phase_transition_target(phase, status, fcfs_closed_enabled=fcfs_on)
    exp_status, exp_outcome = _expected(phase, status, fcfs_on=fcfs_on)
    assert isinstance(got, PhaseTransitionOutcome)
    assert got.target_status == exp_status, (
        f"{phase}/{status} flag={fcfs_on}: status {got.target_status} != {exp_status}"
    )
    assert got.outcome == exp_outcome, (
        f"{phase}/{status} flag={fcfs_on}: outcome {got.outcome} != {exp_outcome}"
    )


def test_fcfs_closed_gated_when_flag_off():
    """신규 fcfs+closed 는 기본(flag OFF) 배포 시 dormant — 무전이 유지."""
    for phase in ("fcfs_residual", "queue_sale"):
        out = resolve_phase_transition_target(phase, "closed", fcfs_closed_enabled=False)
        assert out.outcome == _GATED
        assert out.target_status is None


def test_fcfs_closed_maps_bidding_closed_when_flag_on():
    """flag ON 시 fcfs/큐 판매 close → BIDDING_CLOSED (lottery/membership+closed 와 일관)."""
    for phase in ("fcfs_residual", "queue_sale"):
        out = resolve_phase_transition_target(phase, "closed", fcfs_closed_enabled=True)
        assert out.outcome == _MAPPED
        assert out.target_status == EventStatus.BIDDING_CLOSED


def test_unmapped_combinations_are_flagged_not_silent():
    """조용한 유실 금지: 매핑 없는 조합은 unmapped 로 명시(핸들러가 ERROR 로그)."""
    silent_cases = [
        ("waitlist_promotion", "open"),
        ("waitlist_promotion", "closed"),
        ("queue_sale", "open"),
        ("lottery", "scheduled"),
        ("fcfs_residual", "skipped"),
    ]
    for phase, status in silent_cases:
        out = resolve_phase_transition_target(phase, status, fcfs_closed_enabled=True)
        assert out.outcome == _UNMAPPED, f"{phase}/{status} should be unmapped"
        assert out.target_status is None


def test_allocated_status_maps_regardless_of_phase():
    for phase in _PHASES:
        out = resolve_phase_transition_target(phase, "allocated", fcfs_closed_enabled=False)
        assert out.target_status == EventStatus.ALLOCATED
        assert out.outcome == _MAPPED
