"""
Weight Simulation — 가중치 정책 미리보기
========================================

주최사 설정 화면에서 "이 정책이면 응모자 유형별 당첨 확률이 어떻게 되나"를 보여 준다.

- 가중 추첨(weighted_lottery): Efraimidis–Spirakis 키(−ln U / w)를 반복 표본으로 뽑아
  상위 K 명의 비율을 센다(몬테카를로). 실제 추첨과 같은 표본 규칙이다.
- 가중 배분(weighted_allocation): 가중 가치(AP × w)가 높은 순으로 결정적으로 배정된다.
  동점 구간만 무작위이므로 기대 확률을 정확히 계산한다.

미리보기는 설명용이다 — 실제 추첨은 풀의 사전 커밋 시드로 단 한 번 실행된다.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from talkfile_engine.weight_policy import ALGORITHM_WEIGHTED_ALLOCATION, WeightPolicy, compute_weight

MAX_POPULATION = 200_000
MAX_ITERATIONS = 2_000


@dataclass(frozen=True)
class Profile:
    """응모자 유형 (예: '신규', '팬클럽 3년차')."""

    key: str
    label: str
    count: int
    invested_ap: int = 0
    fan_weight: float = 1.0
    pity_bonus: float = 1.0
    tenure_score: float = 0.0


# 화면 기본 시나리오 — 주최사가 인원만 바꿔 쓴다.
DEFAULT_PROFILES: list[Profile] = [
    Profile("newcomer", "신규 가입자", 400, invested_ap=0, fan_weight=1.0, tenure_score=0.0),
    Profile("casual", "일반 응모자", 400, invested_ap=300, fan_weight=1.0, tenure_score=0.3),
    Profile("fan", "팬클럽 회원", 150, invested_ap=1000, fan_weight=1.5, tenure_score=0.6),
    Profile("veteran", "장기 활동 팬", 40, invested_ap=2000, fan_weight=1.8, tenure_score=1.0),
    Profile("unlucky", "연속 낙첨자", 10, invested_ap=300, fan_weight=1.0, pity_bonus=1.6, tenure_score=0.3),
]


def simulate(
    policy: WeightPolicy,
    profiles: list[Profile],
    seats: int,
    iterations: int = 400,
    seed: int = 20261117,
) -> dict:
    """유형별 1인 가중치와 당첨 확률."""
    policy.validate()
    profiles = [p for p in profiles if p.count > 0]
    total = sum(p.count for p in profiles)
    if total > MAX_POPULATION:
        raise ValueError(f"population too large (max {MAX_POPULATION})")
    if seats < 0:
        raise ValueError("seats must be non-negative")
    iterations = max(1, min(int(iterations), MAX_ITERATIONS))

    weights = [
        compute_weight(policy, p.invested_ap, p.fan_weight, p.pity_bonus, p.tenure_score) for p in profiles
    ]
    if total == 0:
        probs = [0.0] * len(profiles)
    elif seats >= total:
        probs = [1.0] * len(profiles)
    elif policy.algorithm == ALGORITHM_WEIGHTED_ALLOCATION:
        probs = _allocation_probabilities(profiles, weights, seats)
    else:
        probs = _lottery_probabilities(profiles, weights, seats, iterations, seed)

    total_weight = sum(w * p.count for w, p in zip(weights, profiles))
    return {
        "algorithm": policy.algorithm,
        "policy_hash": policy.policy_hash(),
        "seats": seats,
        "applicants": total,
        "competition_ratio": round(total / seats, 3) if seats else None,
        "iterations": iterations if policy.algorithm != ALGORITHM_WEIGHTED_ALLOCATION else None,
        "profiles": [
            {
                "key": p.key,
                "label": p.label,
                "count": p.count,
                "weight": round(w, 4),
                "weight_share": round(w * p.count / total_weight, 6) if total_weight else 0.0,
                "win_probability": round(prob, 6),
                "expected_winners": round(prob * p.count, 2),
            }
            for p, w, prob in zip(profiles, weights, probs)
        ],
    }


def _lottery_probabilities(profiles, weights, seats, iterations, seed) -> list[float]:
    rng = np.random.default_rng(seed)
    w = np.concatenate([np.full(p.count, wt, dtype=np.float64) for p, wt in zip(profiles, weights)])
    group = np.concatenate([np.full(p.count, i, dtype=np.int32) for i, p in enumerate(profiles)])
    wins = np.zeros(len(profiles), dtype=np.float64)
    for _ in range(iterations):
        u = rng.random(w.shape[0])
        u[u == 0] = np.finfo(np.float64).tiny
        keys = -np.log(u) / w
        chosen = np.argpartition(keys, seats - 1)[:seats]
        wins += np.bincount(group[chosen], minlength=len(profiles))
    return [float(wins[i] / (iterations * p.count)) for i, p in enumerate(profiles)]


def _allocation_probabilities(profiles, weights, seats) -> list[float]:
    values = [p.invested_ap * w for p, w in zip(profiles, weights)]
    order = sorted(range(len(profiles)), key=lambda i: -values[i])
    probs = [0.0] * len(profiles)
    remaining = seats
    i = 0
    while i < len(order) and remaining > 0:
        # 같은 가중 가치 묶음(동점) — 남은 좌석을 묶음 안에서 균등 무작위로 나눈다
        tie = [order[i]]
        while i + len(tie) < len(order) and values[order[i + len(tie)]] == values[order[i]]:
            tie.append(order[i + len(tie)])
        size = sum(profiles[j].count for j in tie)
        if size <= remaining:
            for j in tie:
                probs[j] = 1.0
            remaining -= size
        else:
            for j in tie:
                probs[j] = remaining / size
            remaining = 0
        i += len(tie)
    return probs
