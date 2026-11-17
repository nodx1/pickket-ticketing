"""
Weight Policy — 주최사가 설정하는 가중치 추첨 정책
==================================================

추첨 가중치 공식의 계수를 코드 상수에서 "정책 데이터"로 끌어낸다.

    가중치 = base_weight
           + log₂(min(AP, ap_cap) + 1) × ap_scale        (AP 투입 보너스)
           + (fan_weight − 1) × fan_coef                 (팬 활동 보정)
           + (pity_bonus − 1) × pity_coef                (연속 낙첨 보정)
           + tenure_score × tenure_coef                  (정상 누적 시간 보정, 0~1)

- 기본 정책(`WeightPolicy()`)은 기존 상수(SALE_MODE_POLICY_v2 §3-2)와 **비트 단위로 같은**
  가중치를 낸다. 덧셈 순서도 기존 `compute_lottery_weight` 와 같고, tenure 항은 마지막에
  더하므로 tenure_coef=0 이면 결과가 바뀌지 않는다(회귀 테스트로 고정).
- `algorithm` 은 배분 방식이다.
    * ``weighted_lottery`` — Efraimidis–Spirakis 가중 비복원 추출(기본, 기존 동작)
    * ``weighted_allocation`` — 가중 VCG(Vickrey–Clarke–Groves) 배분. 투입 AP 를 입찰로,
                             이 정책의 가중치를 w_i 로 쓴다(`vcg_allocation.py`).
- 정책은 추첨 풀의 사전 커밋 시점에 스냅숏되고 `policy_hash` 로 고정된다. 커밋 이후의
  정책 변경은 그 풀에 영향을 줄 수 없다(사후 조작 방지). 해시는 공정성 증명서에 실린다.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, replace

POLICY_DOMAIN = "pickket-weight-policy-v1"

ALGORITHM_WEIGHTED_LOTTERY = "weighted_lottery"
ALGORITHM_WEIGHTED_ALLOCATION = "weighted_allocation"  # 내부 구현: 가중 VCG (vcg_allocation.py)
ALGORITHMS = (ALGORITHM_WEIGHTED_LOTTERY, ALGORITHM_WEIGHTED_ALLOCATION)

# 주최사 화면의 입력 범위. 범위를 벗어난 값은 저장 단계에서 거부한다.
LIMITS: dict[str, tuple[float, float]] = {
    "base_weight": (1.0, 1000.0),
    "ap_scale": (0.0, 100.0),
    "ap_cap": (0, 10000),
    "fan_coef": (0.0, 300.0),
    "pity_coef": (0.0, 500.0),
    "tenure_coef": (0.0, 300.0),
    "vcg_stabilization_lambda": (0.0, 1.0),
}


@dataclass(frozen=True)
class WeightPolicy:
    """가중치 추첨 정책. 기본값 = 기존 운영 상수."""

    algorithm: str = ALGORITHM_WEIGHTED_LOTTERY
    base_weight: float = 100.0
    ap_scale: float = 15.0
    ap_cap: int = 3000
    fan_coef: float = 50.0
    pity_coef: float = 150.0
    tenure_coef: float = 0.0
    # 가중 VCG 전용: 가격 안정화 λ. 0 이면 순수 VCG(전략적 정직성 DSIC 보장).
    vcg_stabilization_lambda: float = 0.0
    version: int = 1

    # ── 검증 ──
    def validate(self) -> None:
        if self.algorithm not in ALGORITHMS:
            raise ValueError(f"algorithm must be one of {ALGORITHMS}, got {self.algorithm!r}")
        for name, (lo, hi) in LIMITS.items():
            value = getattr(self, name)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"{name} must be numeric")  # noqa: TRY004 — 입력 검증 오류는 ValueError 로 통일
            if math.isnan(value) or math.isinf(value):
                raise ValueError(f"{name} must be finite")
            if value < lo or value > hi:
                raise ValueError(f"{name} must be within [{lo}, {hi}], got {value}")
        if not isinstance(self.ap_cap, int):
            raise ValueError("ap_cap must be an integer")  # noqa: TRY004
        if not isinstance(self.version, int) or self.version < 1:
            raise ValueError("version must be a positive integer")

    # ── 직렬화 ──
    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict | None) -> WeightPolicy:
        if not data:
            return cls()
        known = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
        if "ap_cap" in known and isinstance(known["ap_cap"], float) and known["ap_cap"].is_integer():
            known["ap_cap"] = int(known["ap_cap"])
        policy = cls(**known)
        policy.validate()
        return policy

    def canonical_json(self) -> str:
        """정책 해시 입력. 키 정렬·공백 제거로 언어와 무관하게 재현 가능."""
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))

    def policy_hash(self) -> str:
        """SHA-256(domain ‖ canonical_json). 공정성 증명서에 실린다."""
        return hashlib.sha256(f"{POLICY_DOMAIN}|{self.canonical_json()}".encode()).hexdigest()

    def with_changes(self, **changes) -> WeightPolicy:
        policy = replace(self, **changes)
        policy.validate()
        return policy


# 주최사 화면의 프리셋. 값은 기본 정책에서 일부만 바꾼다.
PRESETS: dict[str, WeightPolicy] = {
    # 모두 같은 확률 — 가중치 없이 순수 무작위
    "uniform": WeightPolicy(ap_scale=0.0, fan_coef=0.0, pity_coef=0.0, tenure_coef=0.0),
    # 기존 운영 기본값
    "standard": WeightPolicy(),
    # 팬 활동을 두 배로 반영
    "fan_first": WeightPolicy(fan_coef=100.0),
    # 정상적으로 오래 활동한 사용자를 우대
    "loyalty_first": WeightPolicy(tenure_coef=80.0),
}


def compute_ap_bonus(invested_ap: int, policy: WeightPolicy) -> float:
    if invested_ap <= 0 or policy.ap_scale == 0:
        return 0.0
    capped = min(invested_ap, policy.ap_cap)
    return math.log2(capped + 1) * policy.ap_scale


def compute_weight(
    policy: WeightPolicy,
    invested_ap: int,
    fan_weight: float = 1.0,
    pity_bonus: float = 1.0,
    tenure_score: float = 0.0,
) -> float:
    """정책 기반 가중치. 항상 ≥ 1.

    덧셈 순서는 기존 `lottery.compute_lottery_weight` 와 같다(기본 정책에서 비트 동일).
    """
    ap_bonus = compute_ap_bonus(invested_ap, policy)
    fan_adjustment = (fan_weight - 1.0) * policy.fan_coef
    pity_adjustment = (pity_bonus - 1.0) * policy.pity_coef
    weight = policy.base_weight + ap_bonus + fan_adjustment + pity_adjustment
    if policy.tenure_coef:
        score = min(max(tenure_score, 0.0), 1.0)
        weight = weight + score * policy.tenure_coef
    return max(weight, 1.0)


def format_weight(weight: float) -> str:
    """가중치를 언어 간 동일한 문자열로 만든다.

    Python `repr(float)` 과 JavaScript `String(number)` 은 둘 다 "가장 짧은 왕복 표현"을
    쓰므로 1 ≤ w < 1e16 구간에서 숫자열이 같다. 차이는 정수형 실수의 꼬리 ".0" 뿐이라
    그것만 떼어 낸다. `float(format_weight(w)) == w` 가 항상 성립한다.
    """
    text = repr(float(weight))
    text = text.removesuffix(".0")
    return text
