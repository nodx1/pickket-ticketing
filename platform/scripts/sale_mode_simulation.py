"""
Pickket 판매모드 v2 시뮬레이션
- 소비자 5계층 × AP 정책(현행 vs 1년 절대소멸) × 추첨 공정성
- 주최자 4유형 × 모드 조합별 매진율·만족도
"""

import math
import random
import statistics
from dataclasses import dataclass, field
from collections import defaultdict
from typing import Literal

random.seed(42)

# ═══════════════════════════════════════════════════════════════
# 1. AP 축적 시뮬레이션 — 현행 vs 1년 절대소멸
# ═══════════════════════════════════════════════════════════════

@dataclass
class APBatch:
    amount: float
    earned_day: int  # 적립일 (시뮬 시작 기준 일수)

    def effective(self, current_day: int, half_life: int = 365) -> float:
        """감쇠 적용 실효 AP"""
        age = current_day - self.earned_day
        decay = math.exp(-math.log(2) / half_life * age)
        return self.amount * decay

    def is_expired_absolute(self, current_day: int, max_days: int = 365) -> bool:
        return (current_day - self.earned_day) >= max_days


@dataclass
class UserProfile:
    name: str
    segment: str
    # 주간 활동 패턴 (52주 = 1년)
    weekly_ap_earn: float       # 주당 평균 적립 AP
    events_per_year: int        # 연간 응모 횟수
    ap_per_bid: float           # 응모당 투입 AP
    description: str = ""


# 5 소비자 계층 정의
USER_PROFILES = [
    UserProfile(
        name="고래 유저 (상위 1%)",
        segment="whale",
        weekly_ap_earn=350,   # 매일 출석 + 리뷰 + SNS + 구매
        events_per_year=24,   # 월 2회 응모
        ap_per_bid=2000,      # 대량 투입
        description="매일 접속, 모든 활동 참여, 팬클럽 3개 이상"
    ),
    UserProfile(
        name="열성 팬 (상위 10%)",
        segment="active",
        weekly_ap_earn=180,   # 주 5일 출석 + 간헐적 리뷰
        events_per_year=12,   # 월 1회 응모
        ap_per_bid=1200,
        description="주 5일 접속, 좋아하는 아티스트 위주 활동"
    ),
    UserProfile(
        name="일반 유저 (중위 50%)",
        segment="regular",
        weekly_ap_earn=80,    # 주 3일 출석
        events_per_year=6,    # 2달에 1회 응모
        ap_per_bid=600,
        description="주 3일 접속, 관심 공연만 응모"
    ),
    UserProfile(
        name="라이트 유저 (하위 30%)",
        segment="light",
        weekly_ap_earn=30,    # 주 1~2일 접속
        events_per_year=3,    # 분기 1회 응모
        ap_per_bid=300,
        description="가끔 접속, 정말 보고 싶은 공연만"
    ),
    UserProfile(
        name="신규 가입자 (3개월차)",
        segment="newbie",
        weekly_ap_earn=120,   # 초기 열정 (웰컴보너스 포함 효과)
        events_per_year=4,    # 가입 후 적극 시도
        ap_per_bid=400,
        description="가입 후 열심히 활동 중이지만 축적 기간 짧음"
    ),
]


def simulate_ap_accumulation(profile: UserProfile, weeks: int, policy: str) -> dict:
    """
    주 단위 AP 축적 시뮬레이션
    policy: "current" (활동 기반 12개월) | "absolute" (적립일 기준 12개월)
    """
    batches: list[APBatch] = []
    current_day = 0

    # 신규 가입자는 26주(6개월)부터 시뮬 시작
    start_week = 0
    if profile.segment == "newbie":
        start_week = max(0, weeks - 13)  # 최근 13주(3개월)만 활동

    for week in range(weeks):
        current_day = week * 7

        if week >= start_week:
            batches.append(APBatch(amount=profile.weekly_ap_earn, earned_day=current_day))

        # 절대 소멸: 365일 지난 배치 제거
        if policy == "absolute":
            batches = [b for b in batches if not b.is_expired_absolute(current_day)]

    # 현행 정책: 활동 유저는 소멸 없음 (활동 리셋)
    # → 전체 배치 유지, 감쇠만 적용

    final_day = weeks * 7

    if policy == "absolute":
        batches = [b for b in batches if not b.is_expired_absolute(final_day)]

    # 실효 AP (감쇠 적용)
    total_effective = sum(b.effective(final_day) for b in batches)
    # 명목 AP (감쇠 미적용)
    total_nominal = sum(b.amount for b in batches)

    return {
        "profile": profile.name,
        "segment": profile.segment,
        "policy": policy,
        "weeks": weeks,
        "nominal_ap": round(total_nominal),
        "effective_ap": round(total_effective),
        "batch_count": len(batches),
    }


def run_ap_simulation():
    print("=" * 80)
    print("1. AP 축적 시뮬레이션 — 현행 vs 1년 절대소멸")
    print("=" * 80)

    for period_label, weeks in [("1년 후", 52), ("2년 후", 104), ("3년 후", 156)]:
        print(f"\n{'─' * 60}")
        print(f"  ⏱  {period_label} (활동 {weeks}주)")
        print(f"{'─' * 60}")
        print(f"{'유저 계층':<22} {'현행 실효AP':>12} {'절대소멸 실효AP':>16} {'격차 축소율':>12}")
        print(f"{'─' * 60}")

        results = {}
        for profile in USER_PROFILES:
            current = simulate_ap_accumulation(profile, weeks, "current")
            absolute = simulate_ap_accumulation(profile, weeks, "absolute")
            results[profile.segment] = (current, absolute)

            reduction = 0
            if current["effective_ap"] > 0:
                reduction = (1 - absolute["effective_ap"] / current["effective_ap"]) * 100

            print(f"{profile.name:<22} {current['effective_ap']:>10,} AP {absolute['effective_ap']:>14,} AP {reduction:>10.1f}%")

        # 고래 vs 일반 비율
        whale_cur = results["whale"][0]["effective_ap"]
        reg_cur = results["regular"][0]["effective_ap"]
        whale_abs = results["whale"][1]["effective_ap"]
        reg_abs = results["regular"][1]["effective_ap"]

        ratio_cur = whale_cur / max(reg_cur, 1)
        ratio_abs = whale_abs / max(reg_abs, 1)

        print(f"\n  📊 고래/일반 AP 비율: 현행 {ratio_cur:.1f}배 → 절대소멸 {ratio_abs:.1f}배")

        # 신규 vs 고래
        newbie_abs = results["newbie"][1]["effective_ap"]
        newbie_ratio = whale_abs / max(newbie_abs, 1)
        print(f"  📊 고래/신규 AP 비율: 절대소멸 {newbie_ratio:.1f}배")


# ═══════════════════════════════════════════════════════════════
# 2. 추첨(LOTTERY) 시뮬레이션 — 당첨 분포
# ═══════════════════════════════════════════════════════════════

def weighted_lottery(users: list[dict], num_winners: int) -> list[dict]:
    """AP 가중치 추첨. 가중치 = effective_ap + base(100, 최소 보장)"""
    pool = list(users)
    winners = []

    for _ in range(min(num_winners, len(pool))):
        weights = [max(u["effective_ap"] + 100, 100) for u in pool]  # 최소 100 보장
        total = sum(weights)
        probs = [w / total for w in weights]

        chosen_idx = random.choices(range(len(pool)), weights=probs, k=1)[0]
        winners.append(pool.pop(chosen_idx))

    return winners


def run_lottery_simulation():
    print("\n\n" + "=" * 80)
    print("2. 공정 추첨 시뮬레이션 — 10만 유저 × 1,000석 × 100회 반복")
    print("=" * 80)

    NUM_USERS = 100_000
    NUM_SEATS = 1_000
    NUM_TRIALS = 100

    # 유저 분포: 고래 1%, 열성 9%, 일반 50%, 라이트 30%, 신규 10%
    segment_dist = {
        "whale": 0.01,
        "active": 0.09,
        "regular": 0.50,
        "light": 0.30,
        "newbie": 0.10,
    }

    for policy in ["current", "absolute"]:
        print(f"\n{'─' * 70}")
        policy_label = "현행 (무한축적)" if policy == "current" else "1년 절대소멸"
        print(f"  정책: {policy_label}")
        print(f"{'─' * 70}")

        # 2년 활동 기준 AP 생성
        ap_by_segment = {}
        for profile in USER_PROFILES:
            result = simulate_ap_accumulation(profile, 104, policy)  # 2년
            ap_by_segment[profile.segment] = result["effective_ap"]

        # 세그먼트별 당첨 통계
        segment_wins = defaultdict(list)

        for trial in range(NUM_TRIALS):
            # 유저 풀 생성 (샘플링으로 축소)
            sample_size = 5000  # 성능을 위해 축소
            users = []
            for segment, ratio in segment_dist.items():
                count = int(sample_size * ratio)
                base_ap = ap_by_segment[segment]
                for i in range(count):
                    # ±30% 개인 편차
                    personal_ap = base_ap * random.uniform(0.7, 1.3)
                    users.append({
                        "id": f"{segment}_{i}",
                        "segment": segment,
                        "effective_ap": personal_ap,
                    })

            # 1,000석 중 50석 비율로 축소 (5000명 중 50석)
            seats = 50
            winners = weighted_lottery(users, seats)

            # 세그먼트별 당첨 수
            trial_wins = defaultdict(int)
            for w in winners:
                trial_wins[w["segment"]] += 1

            for segment in segment_dist:
                segment_wins[segment].append(trial_wins.get(segment, 0))

        print(f"{'계층':<22} {'비율':>6} {'평균 당첨':>10} {'당첨 점유율':>12} {'기대값 대비':>12}")
        print(f"{'─' * 70}")

        total_seats_per_trial = 50
        for profile in USER_PROFILES:
            seg = profile.segment
            avg_wins = statistics.mean(segment_wins[seg])
            share = avg_wins / total_seats_per_trial * 100
            expected_share = segment_dist[seg] * 100
            ratio = share / expected_share if expected_share > 0 else 0
            pop_pct = segment_dist[seg] * 100

            print(f"{profile.name:<22} {pop_pct:>5.0f}% {avg_wins:>8.1f}석 {share:>10.1f}% {ratio:>10.2f}x")

        # 지니 계수 계산
        all_wins_flat = []
        for segment, ratio in segment_dist.items():
            count = int(5000 * ratio)
            avg_per_person = statistics.mean(segment_wins[segment]) / count if count > 0 else 0
            all_wins_flat.extend([avg_per_person] * count)

        all_wins_flat.sort()
        n = len(all_wins_flat)
        if n > 0 and sum(all_wins_flat) > 0:
            gini = sum((2 * (i + 1) - n - 1) * x for i, x in enumerate(all_wins_flat)) / (n * sum(all_wins_flat))
            print(f"\n  📊 당첨 지니계수: {gini:.4f} (0=완전 균등, 1=완전 불균등)")


# ═══════════════════════════════════════════════════════════════
# 3. 주최자 관점 시뮬레이션
# ═══════════════════════════════════════════════════════════════

@dataclass
class EventScenario:
    name: str
    category: str
    capacity: int
    demand_multiplier: float  # 수요/공급 비율
    modes: list[tuple[str, float]]  # (모드, 좌석 할당 비율)
    description: str = ""


EVENT_SCENARIOS = [
    EventScenario(
        name="K-pop 대형 콘서트 (BTS급)",
        category="concert",
        capacity=50000,
        demand_multiplier=20.0,  # 100만 지원 / 5만석
        modes=[("MEMBERSHIP_PRESALE", 0.40), ("LOTTERY", 0.60)],
        description="초수요. 멤버십 40% + 추첨 60%. 잔여 없음."
    ),
    EventScenario(
        name="K-pop 중형 콘서트 (아이돌 그룹)",
        category="concert",
        capacity=10000,
        demand_multiplier=5.0,
        modes=[("MEMBERSHIP_PRESALE", 0.30), ("LOTTERY", 0.40), ("QUEUE_SALE", 0.30)],
        description="고수요. 3단계 퍼널."
    ),
    EventScenario(
        name="뮤지컬 (장기 공연)",
        category="musical",
        capacity=1500,
        demand_multiplier=2.0,
        modes=[("LOTTERY", 0.50), ("QUEUE_SALE", 0.50)],
        description="중수요. 추첨 + 대기열."
    ),
    EventScenario(
        name="소형 인디 공연",
        category="concert",
        capacity=300,
        demand_multiplier=1.2,
        modes=[("QUEUE_SALE", 1.0)],
        description="저수요. 대기열 단독."
    ),
    EventScenario(
        name="프로야구 플레이오프",
        category="sports",
        capacity=25000,
        demand_multiplier=8.0,
        modes=[("MEMBERSHIP_PRESALE", 0.50), ("QUEUE_SALE", 0.30), ("FCFS_RESIDUAL", 0.20)],
        description="시즌권 홀더 우선 + 일반 대기열 + 잔여."
    ),
    EventScenario(
        name="대형 페스티벌",
        category="festival",
        capacity=30000,
        demand_multiplier=3.0,
        modes=[("LOTTERY", 1.0)],
        description="추첨 단독. Glastonbury 모델."
    ),
]


def simulate_event(scenario: EventScenario) -> dict:
    """이벤트 시나리오별 매진율, 소요시간, 만족도 시뮬"""
    total_demand = int(scenario.capacity * scenario.demand_multiplier)
    results = {}
    remaining_demand = total_demand
    total_sold = 0

    phase_results = []

    for mode, allocation in scenario.modes:
        seats = int(scenario.capacity * allocation)

        if mode == "MEMBERSHIP_PRESALE":
            # 멤버십 회원은 전체 수요의 약 15~25%
            membership_demand = int(total_demand * random.uniform(0.15, 0.25))
            applicants = min(membership_demand, remaining_demand)
            sold = min(seats, applicants)
            fill_rate = sold / seats * 100

            # 추첨 방식이므로 팬 만족도 높음 (시간 스트레스 없음)
            satisfaction = 85 if sold < applicants else 90
            # 낙첨자 불만
            if applicants > seats:
                rejection_rate = (applicants - sold) / applicants * 100
                satisfaction -= min(rejection_rate * 0.1, 15)

            phase_results.append({
                "mode": "멤버십 선판매",
                "seats": seats,
                "applicants": applicants,
                "sold": sold,
                "fill_rate": fill_rate,
                "satisfaction": round(satisfaction, 1),
                "time": "5~14일 (응모기간)",
            })

        elif mode == "LOTTERY":
            applicants = min(int(remaining_demand * 0.7), remaining_demand)
            sold = min(seats, applicants)
            fill_rate = sold / seats * 100

            satisfaction = 80
            if applicants > seats:
                # AP 가중치로 팬심 반영 → 만족도 약간 상승
                satisfaction = 82
                rejection_rate = (applicants - sold) / applicants * 100
                satisfaction -= min(rejection_rate * 0.08, 12)

            phase_results.append({
                "mode": "공정 추첨",
                "seats": seats,
                "applicants": applicants,
                "sold": sold,
                "fill_rate": fill_rate,
                "satisfaction": round(satisfaction, 1),
                "time": "7~14일 (응모기간)",
            })

        elif mode == "QUEUE_SALE":
            applicants = min(int(remaining_demand * 0.5), remaining_demand)
            sold = min(seats, applicants)
            fill_rate = sold / seats * 100

            # 랜덤 큐: FCFS보다 공정하지만 대기 스트레스 있음
            satisfaction = 75
            if fill_rate >= 95:
                satisfaction = 72  # 거의 매진 → 대기열 긴장감

            phase_results.append({
                "mode": "대기열 판매",
                "seats": seats,
                "applicants": applicants,
                "sold": sold,
                "fill_rate": fill_rate,
                "satisfaction": round(satisfaction, 1),
                "time": "실시간 (수시간)",
            })

        elif mode == "FCFS_RESIDUAL":
            applicants = min(int(remaining_demand * 0.3), remaining_demand)
            sold = min(seats, applicants)
            fill_rate = sold / seats * 100

            # 잔여석이므로 경쟁 낮음 → 스트레스 낮음
            satisfaction = 78 if fill_rate < 80 else 70

            phase_results.append({
                "mode": "잔여 선착순",
                "seats": seats,
                "applicants": applicants,
                "sold": sold,
                "fill_rate": fill_rate,
                "satisfaction": round(satisfaction, 1),
                "time": "실시간 (즉시)",
            })

        total_sold += sold
        remaining_demand -= applicants
        remaining_demand = max(0, remaining_demand)

    # WAITLIST 시뮬: 취소율 5~8%, 재배정 성공률 95%
    cancel_rate = random.uniform(0.05, 0.08)
    cancels = int(total_sold * cancel_rate)
    waitlist_demand = int((total_demand - total_sold) * 0.3)  # 30%가 대기 등록
    waitlist_filled = min(cancels, waitlist_demand)
    waitlist_success = waitlist_filled / max(cancels, 1) * 100

    return {
        "scenario": scenario.name,
        "category": scenario.category,
        "capacity": scenario.capacity,
        "total_demand": total_demand,
        "demand_ratio": f"{scenario.demand_multiplier:.1f}:1",
        "phases": phase_results,
        "total_sold": total_sold,
        "overall_fill_rate": total_sold / scenario.capacity * 100,
        "waitlist_cancels": cancels,
        "waitlist_filled": waitlist_filled,
        "waitlist_success_rate": waitlist_success,
        "modes_used": " → ".join(m for m, _ in scenario.modes),
        "description": scenario.description,
    }


def run_organizer_simulation():
    print("\n\n" + "=" * 80)
    print("3. 주최자 관점 시뮬레이션 — 6가지 이벤트 시나리오")
    print("=" * 80)

    for scenario in EVENT_SCENARIOS:
        result = simulate_event(scenario)

        print(f"\n{'━' * 70}")
        print(f"  🎪 {result['scenario']}")
        print(f"  수용: {result['capacity']:,}석 | 수요: {result['total_demand']:,}명 ({result['demand_ratio']})")
        print(f"  조합: {result['modes_used']}")
        print(f"{'━' * 70}")

        print(f"  {'단계':<16} {'좌석':>7} {'응모':>8} {'판매':>7} {'매진율':>7} {'만족도':>7} {'소요시간':<18}")
        print(f"  {'─' * 68}")

        for phase in result["phases"]:
            print(f"  {phase['mode']:<16} {phase['seats']:>6,} {phase['applicants']:>7,} {phase['sold']:>6,} {phase['fill_rate']:>6.1f}% {phase['satisfaction']:>5.1f}점 {phase['time']:<18}")

        print(f"  {'─' * 68}")
        print(f"  총 매진율: {result['overall_fill_rate']:.1f}% ({result['total_sold']:,}/{result['capacity']:,})")
        print(f"  P3 대기열: 취소 {result['waitlist_cancels']}건 → 재배정 {result['waitlist_filled']}건 (성공률 {result['waitlist_success_rate']:.0f}%)")


# ═══════════════════════════════════════════════════════════════
# 4. 소비자 여정 시뮬레이션 — 세그먼트별 1년 경험
# ═══════════════════════════════════════════════════════════════

def run_consumer_journey_simulation():
    print("\n\n" + "=" * 80)
    print("4. 소비자 여정 시뮬레이션 — 1년간 응모·당첨·낙첨 경험")
    print("=" * 80)

    # 1년 절대소멸 정책 기준
    for profile in USER_PROFILES:
        ap_result = simulate_ap_accumulation(profile, 52, "absolute")
        effective_ap = ap_result["effective_ap"]

        # 1년간 응모 시뮬
        total_events = profile.events_per_year
        wins = 0
        losses = 0
        total_ap_spent = 0
        total_ap_refunded = 0
        total_consolation = 0

        for event in range(total_events):
            # 경쟁률: 인기 공연 5:1 ~ 20:1 랜덤
            competition = random.uniform(3, 15)
            base_win_prob = 1 / competition

            # AP 가중치 효과: 실효AP 기준으로 당첨 확률 보정
            # 기본 100AP + 투입AP로 가중
            bid_ap = min(profile.ap_per_bid, effective_ap)
            weight_boost = (bid_ap + 100) / (600 + 100)  # 일반 유저(600AP) 대비
            adjusted_prob = min(base_win_prob * weight_boost * 1.5, 0.8)

            if random.random() < adjusted_prob:
                wins += 1
                total_ap_spent += bid_ap
            else:
                losses += 1
                total_ap_refunded += bid_ap  # 100% 환급
                consolation = min(max(bid_ap * 0.1, 50), 500)
                total_consolation += consolation

        win_rate = wins / max(total_events, 1) * 100

        print(f"\n{'─' * 60}")
        print(f"  👤 {profile.name}")
        print(f"     {profile.description}")
        print(f"{'─' * 60}")
        print(f"  실효 AP (1년 절대소멸): {effective_ap:,} AP")
        print(f"  연간 응모: {total_events}회 → 당첨 {wins}회, 낙첨 {losses}회 (당첨률 {win_rate:.0f}%)")
        print(f"  AP 소비: {total_ap_spent:,.0f} | 환급: {total_ap_refunded:,.0f} | 위로금: {total_consolation:,.0f}")

        # 감정 평가
        if win_rate >= 50:
            mood = "😊 만족 — 절반 이상 당첨, 플랫폼 충성도 높음"
        elif win_rate >= 30:
            mood = "😐 보통 — 아쉽지만 낙첨 보상으로 수용 가능"
        elif win_rate >= 15:
            mood = "😤 불만 — 당첨이 너무 어려움, 이탈 위험"
        else:
            mood = "😡 이탈 위험 — 거의 당첨 못 함, 플랫폼 신뢰 하락"
        print(f"  감정: {mood}")


# ═══════════════════════════════════════════════════════════════
# 5. QUEUE_SALE 공정성 — 랜덤큐 vs 접속순 비교
# ═══════════════════════════════════════════════════════════════

def run_queue_comparison():
    print("\n\n" + "=" * 80)
    print("5. 대기열 판매 — 랜덤 큐 vs 접속순(NOL식) 비교")
    print("=" * 80)

    NUM_USERS = 10000
    NUM_SEATS = 1000
    NUM_TRIALS = 200

    # 접속 속도 분포: 봇(상위 0.5%) → 광클러(5%) → 일반(94.5%)
    for queue_type in ["접속순 (NOL식)", "랜덤 큐 (Pickket)"]:
        bot_wins = 0
        power_wins = 0
        normal_wins = 0

        for _ in range(NUM_TRIALS):
            if "접속순" in queue_type:
                # 봇: 50명 (0.5%), 항상 상위 순번
                # 광클러: 500명 (5%), 상위 30% 분포
                # 일반: 9450명, 균등 분포
                positions = []
                for i in range(50):   # 봇
                    positions.append(("bot", random.randint(1, 100)))
                for i in range(500):  # 광클러
                    positions.append(("power", random.randint(50, 3000)))
                for i in range(9450): # 일반
                    positions.append(("normal", random.randint(1, 10000)))

                positions.sort(key=lambda x: x[1])
                winners = positions[:NUM_SEATS]
            else:
                # 랜덤: 모두 동일 확률
                users = [("bot", i) for i in range(50)]
                users += [("power", i) for i in range(500)]
                users += [("normal", i) for i in range(9450)]
                random.shuffle(users)
                winners = users[:NUM_SEATS]

            for user_type, _ in winners:
                if user_type == "bot":
                    bot_wins += 1
                elif user_type == "power":
                    power_wins += 1
                else:
                    normal_wins += 1

        total_wins = bot_wins + power_wins + normal_wins
        print(f"\n  📊 {queue_type}")
        print(f"  {'유저 유형':<16} {'인구 비율':>10} {'당첨 점유율':>12} {'기대값 대비':>12}")
        print(f"  {'─' * 54}")

        bot_share = bot_wins / total_wins * 100
        power_share = power_wins / total_wins * 100
        normal_share = normal_wins / total_wins * 100

        print(f"  {'봇 (0.5%)':<16} {'0.5%':>10} {bot_share:>10.1f}% {bot_share/0.5:>10.1f}x")
        print(f"  {'광클러 (5%)':<16} {'5.0%':>10} {power_share:>10.1f}% {power_share/5:>10.1f}x")
        print(f"  {'일반 유저 (94.5%)':<16} {'94.5%':>10} {normal_share:>10.1f}% {normal_share/94.5:>10.1f}x")


# ═══════════════════════════════════════════════════════════════
# 6. 종합 평가표
# ═══════════════════════════════════════════════════════════════

def run_summary():
    print("\n\n" + "=" * 80)
    print("6. 종합 평가표 — 모드별 이해관계자 만족도 매트릭스")
    print("=" * 80)

    modes = [
        ("멤버십 선판매", {
            "고래 팬": 95, "열성 팬": 85, "일반 팬": 40, "신규 팬": 30,
            "대형 기획사": 95, "중소 기획사": 60, "스포츠 구단": 85, "페스티벌": 50,
            "봇 차단": 90, "암표 방지": 85, "서버 부하": 95, "매진 속도": 70,
        }),
        ("공정 추첨", {
            "고래 팬": 75, "열성 팬": 80, "일반 팬": 75, "신규 팬": 65,
            "대형 기획사": 90, "중소 기획사": 75, "스포츠 구단": 70, "페스티벌": 95,
            "봇 차단": 95, "암표 방지": 90, "서버 부하": 95, "매진 속도": 60,
        }),
        ("대기열 판매", {
            "고래 팬": 60, "열성 팬": 70, "일반 팬": 70, "신규 팬": 75,
            "대형 기획사": 70, "중소 기획사": 85, "스포츠 구단": 80, "페스티벌": 70,
            "봇 차단": 80, "암표 방지": 70, "서버 부하": 80, "매진 속도": 85,
        }),
        ("잔여 선착순", {
            "고래 팬": 50, "열성 팬": 55, "일반 팬": 65, "신규 팬": 70,
            "대형 기획사": 40, "중소 기획사": 90, "스포츠 구단": 75, "페스티벌": 60,
            "봇 차단": 50, "암표 방지": 50, "서버 부하": 60, "매진 속도": 95,
        }),
    ]

    categories = [
        ("소비자", ["고래 팬", "열성 팬", "일반 팬", "신규 팬"]),
        ("주최자", ["대형 기획사", "중소 기획사", "스포츠 구단", "페스티벌"]),
        ("운영", ["봇 차단", "암표 방지", "서버 부하", "매진 속도"]),
    ]

    for cat_name, stakeholders in categories:
        print(f"\n  {'─' * 70}")
        print(f"  [{cat_name}]")
        header = f"  {'모드':<16}"
        for s in stakeholders:
            header += f" {s:>10}"
        header += f" {'평균':>8}"
        print(header)
        print(f"  {'─' * 70}")

        for mode_name, scores in modes:
            row = f"  {mode_name:<16}"
            vals = []
            for s in stakeholders:
                v = scores[s]
                vals.append(v)
                row += f" {v:>9}점"
            avg = statistics.mean(vals)
            row += f" {avg:>6.1f}점"
            print(row)


# ═══════════════════════════════════════════════════════════════
# 실행
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    run_ap_simulation()
    run_lottery_simulation()
    run_organizer_simulation()
    run_consumer_journey_simulation()
    run_queue_comparison()
    run_summary()

    print("\n\n" + "=" * 80)
    print("시뮬레이션 완료")
    print("=" * 80)
