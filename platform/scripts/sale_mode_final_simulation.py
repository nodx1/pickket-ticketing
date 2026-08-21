"""
Pickket 판매모드 v2.1 최종 시뮬레이션
- 4모드 + WAITLIST 횡단 + AP 이중용도(추첨/수수료할인) + 1년 절대소멸
- 소비자 5계층 × 주최자 8시나리오 × AP 경제 × 연간 종합
"""

import math
import random
import statistics
from collections import defaultdict
from dataclasses import dataclass, field

random.seed(42)

# ═══════════════════════════════════════════════════════════════
# 수수료 설정 (신규 플랫폼 적정가: 티켓링크 수준 2,000원)
# ═══════════════════════════════════════════════════════════════
BOOKING_FEE = 2000        # 예매 수수료 (원) — 신규 플랫폼 적정가
MAX_DISCOUNT_RATE = 0.70  # AP 할인 상한 70% → 최대 1,400원 할인
# 최소 실결제 수수료 = 2,000 × 0.30 = 600원
# 추첨 AP: 투입 시 소비됨 (당첨/낙첨 무관). 낙첨 환급 없음.

# ═══════════════════════════════════════════════════════════════
# 공정 추첨 v2.1 엔진
# ═══════════════════════════════════════════════════════════════

def calc_lottery_weight(
    ap_invested: int,
    consecutive_losses: int = 0,
    is_newbie: bool = False,
    same_artist_30d: bool = False,
    same_genre_30d: bool = False,
    multi_win_60d: bool = False,
) -> float:
    BASE = 100
    MAX_AP = 3000
    LOG_COEFF = 15
    NEWBIE_BOOST = 30
    LOSS_BONUS = {2: 30, 3: 70, 4: 100}
    COOLDOWN_FLOOR = 0.50

    base = BASE + (NEWBIE_BOOST if is_newbie else 0)
    ap_bonus = math.log2(min(ap_invested, MAX_AP) + 1) * LOG_COEFF
    loss_bonus = LOSS_BONUS.get(
        consecutive_losses, 150 if consecutive_losses >= 5 else 0
    )

    weight = base + ap_bonus + loss_bonus

    cooldown = 1.0
    if same_artist_30d:
        cooldown *= 0.50
    if same_genre_30d:
        cooldown *= 0.80
    if multi_win_60d:
        cooldown *= 0.70
    cooldown = max(cooldown, COOLDOWN_FLOOR)

    return max(weight * cooldown, 10)


# ═══════════════════════════════════════════════════════════════
# 유저 & 이벤트 정의
# ═══════════════════════════════════════════════════════════════

@dataclass
class User:
    id: int
    segment: str
    monthly_ap_earn: int
    ap_per_bid: int
    has_membership: bool = False
    is_newbie: bool = False
    # 상태
    ap_balance: int = 0
    consecutive_losses: int = 0
    recent_wins: list = field(default_factory=list)  # (day, artist, genre)
    total_wins: int = 0
    total_bids: int = 0
    total_fee_paid: int = 0
    total_fee_discount: int = 0
    total_ap_earned: int = 0
    total_ap_expired: int = 0
    tickets_bought: int = 0

SEGMENTS = {
    "whale":   {"ratio": 0.01, "monthly_ap": 2000, "ap_bid": 2000, "membership": True,
                "label": "고래 (1%)",    "desc": "매일 접속, 팬클럽 3개"},
    "active":  {"ratio": 0.09, "monthly_ap": 1100, "ap_bid": 1200, "membership": True,
                "label": "열성 (9%)",    "desc": "주 5일, 팬클럽 1개"},
    "regular": {"ratio": 0.50, "monthly_ap": 600,  "ap_bid": 600,  "membership": False,
                "label": "일반 (50%)",   "desc": "주 3일, 관심 공연만"},
    "light":   {"ratio": 0.30, "monthly_ap": 300,  "ap_bid": 300,  "membership": False,
                "label": "라이트 (30%)", "desc": "가끔 접속"},
    "newbie":  {"ratio": 0.10, "monthly_ap": 1500, "ap_bid": 400,  "membership": False,
                "label": "신규 (10%)",   "desc": "가입 3개월 이내"},
}


def create_population(n: int) -> list[User]:
    users = []
    uid = 0
    for seg, info in SEGMENTS.items():
        count = int(n * info["ratio"])
        for _ in range(count):
            u = User(
                id=uid, segment=seg,
                monthly_ap_earn=int(info["monthly_ap"] * random.uniform(0.8, 1.2)),
                ap_per_bid=int(info["ap_bid"] * random.uniform(0.8, 1.2)),
                has_membership=info["membership"],
                is_newbie=(seg == "newbie"),
            )
            # 초기 AP (가입 보너스 700 + 기존 활동)
            if seg == "newbie":
                u.ap_balance = 700 + info["monthly_ap"]  # 1개월치
            else:
                u.ap_balance = min(info["monthly_ap"] * 6, info["monthly_ap"] * 12)  # 6~12개월
            u.total_ap_earned = u.ap_balance
            users.append(u)
            uid += 1
    return users


# ═══════════════════════════════════════════════════════════════
# 이벤트 시나리오
# ═══════════════════════════════════════════════════════════════

@dataclass
class EventConfig:
    name: str
    category: str
    artist: str
    genre: str
    capacity: int
    demand_mult: float
    phases: list  # [(mode, seat_ratio)]
    cancel_rate: float = 0.06


EVENTS = [
    EventConfig("BTS 고척돔 3만석", "kpop_large", "BTS", "kpop",
                30000, 20.0, [("MEMBERSHIP", 0.40), ("LOTTERY", 0.60)]),
    EventConfig("aespa 올림픽홀 5천석", "kpop_mid", "aespa", "kpop",
                5000, 8.0, [("MEMBERSHIP", 0.30), ("LOTTERY", 0.40), ("QUEUE", 0.30)]),
    EventConfig("뮤지컬 '위키드' 1,500석", "musical", "wicked", "musical",
                1500, 3.0, [("LOTTERY", 0.60), ("QUEUE", 0.40)]),
    EventConfig("인디밴드 홍대 300석", "indie", "indie_band", "indie",
                300, 1.3, [("QUEUE", 1.0)]),
    EventConfig("KBO 플레이오프 25,000석", "sports", "KBO", "sports",
                25000, 6.0, [("MEMBERSHIP", 0.50), ("QUEUE", 0.30), ("FCFS", 0.20)]),
    EventConfig("자라섬 재즈 페스티벌 15,000석", "festival", "jarasum", "festival",
                15000, 2.5, [("LOTTERY", 1.0)]),
    EventConfig("IU 팬미팅 2,000석", "fanmeeting", "IU", "kpop",
                2000, 15.0, [("MEMBERSHIP", 1.0)]),
    EventConfig("전시 '모네展' 일일 500명", "exhibition", "monet", "exhibition",
                500, 1.2, [("FCFS", 1.0)]),
]


# ═══════════════════════════════════════════════════════════════
# 시뮬 1: 이벤트별 판매 시뮬레이션
# ═══════════════════════════════════════════════════════════════

def weighted_draw(candidates: list, weights: list, n: int) -> list[int]:
    """가중치 추첨. 당첨 인덱스 리스트 반환."""
    pool = list(range(len(candidates)))
    pool_w = list(weights)
    winners = []
    for _ in range(min(n, len(pool))):
        if not pool:
            break
        total = sum(pool_w)
        if total <= 0:
            break
        chosen = random.choices(range(len(pool)), weights=[w / total for w in pool_w], k=1)[0]
        winners.append(pool[chosen])
        pool.pop(chosen)
        pool_w.pop(chosen)
    return winners


def simulate_event(event: EventConfig, users: list[User], day: int):
    """단일 이벤트 시뮬. 유저 상태 업데이트. 결과 dict 반환."""
    total_demand = int(event.capacity * event.demand_mult)
    results = {"event": event.name, "capacity": event.capacity,
               "demand": total_demand, "phases": [], "total_sold": 0}

    # 참여 의향 (세그먼트별)
    participation = {
        "whale": 0.80, "active": 0.60, "regular": 0.25,
        "light": 0.12, "newbie": 0.25,
    }

    all_interested = [u for u in users if random.random() < participation[u.segment]]
    random.shuffle(all_interested)
    remaining_pool = list(all_interested)
    total_sold = 0

    for mode, ratio in event.phases:
        seats = int(event.capacity * ratio)
        phase_result = {"mode": mode, "seats": seats, "applicants": 0,
                        "sold": 0, "fill_pct": 0, "avg_satisfaction": 0}

        if mode == "MEMBERSHIP":
            # 멤버십 보유자만
            candidates = [u for u in remaining_pool if u.has_membership]
            candidates = candidates[:int(len(candidates) * 0.9)]  # 90% 실제 응모
            phase_result["applicants"] = len(candidates)

            if len(candidates) <= seats:
                winners_idx = list(range(len(candidates)))
            else:
                # 멤버십 내 추첨 (AP 가중치)
                weights = [calc_lottery_weight(
                    c.ap_per_bid,
                    consecutive_losses=c.consecutive_losses,
                    same_artist_30d=any(a == event.artist for d, a, g in c.recent_wins if day - d <= 30),
                    multi_win_60d=sum(1 for d, a, g in c.recent_wins if day - d <= 60) >= 2,
                ) for c in candidates]
                winners_idx = weighted_draw(candidates, weights, seats)

            sold = len(winners_idx)
            for i in winners_idx:
                w = candidates[i]
                w.total_wins += 1
                w.tickets_bought += 1
                w.consecutive_losses = 0
                w.recent_wins.append((day, event.artist, event.genre))
                # 수수료 할인
                max_discount = int(BOOKING_FEE * MAX_DISCOUNT_RATE)
                discount = min(w.ap_balance, max_discount)
                w.ap_balance -= discount
                w.total_fee_discount += discount
                w.total_fee_paid += (BOOKING_FEE - discount)
                if w in remaining_pool:
                    remaining_pool.remove(w)

            # 비당첨자 연속낙첨 증가
            winner_set = {candidates[i].id for i in winners_idx}
            for c in candidates:
                c.total_bids += 1
                if c.id not in winner_set:
                    c.consecutive_losses += 1

            satisfaction = 82 if sold < len(candidates) else 90
            if len(candidates) > 0 and sold < len(candidates):
                rej = (len(candidates) - sold) / len(candidates)
                satisfaction -= min(rej * 10, 15)

            phase_result.update({"sold": sold, "fill_pct": sold / max(seats, 1) * 100,
                                "avg_satisfaction": round(satisfaction, 1)})

        elif mode == "LOTTERY":
            candidates = remaining_pool[:int(len(remaining_pool) * 0.6)]
            phase_result["applicants"] = len(candidates)

            weights = [calc_lottery_weight(
                c.ap_per_bid,
                consecutive_losses=c.consecutive_losses,
                is_newbie=c.is_newbie,
                same_artist_30d=any(a == event.artist for d, a, g in c.recent_wins if day - d <= 30),
                same_genre_30d=any(g == event.genre for d, a, g in c.recent_wins if day - d <= 30),
                multi_win_60d=sum(1 for d, a, g in c.recent_wins if day - d <= 60) >= 2,
            ) for c in candidates]

            winners_idx = weighted_draw(candidates, weights, seats)
            sold = len(winners_idx)

            winner_set = set()
            for i in winners_idx:
                w = candidates[i]
                w.total_wins += 1
                w.tickets_bought += 1
                w.consecutive_losses = 0
                w.recent_wins.append((day, event.artist, event.genre))
                # 추첨 AP 소비 (당첨자도 투입 AP 사라짐)
                ap_spent = min(w.ap_per_bid, w.ap_balance)
                w.ap_balance -= ap_spent
                # 수수료 할인 (남은 AP에서 추가 차감)
                max_discount = int(BOOKING_FEE * MAX_DISCOUNT_RATE)
                discount = min(w.ap_balance, max_discount)
                w.ap_balance -= discount
                w.total_fee_discount += discount
                w.total_fee_paid += (BOOKING_FEE - discount)
                winner_set.add(w.id)
                if w in remaining_pool:
                    remaining_pool.remove(w)

            # 모든 응모자 AP 소비 (당첨/낙첨 무관 — AP는 투입 시 사라짐)
            for c in candidates:
                c.total_bids += 1
                if c.id not in winner_set:
                    c.consecutive_losses += 1
                    # AP 투입 소비 (낙첨자도 AP 소비됨, 환급 없음)
                    ap_spent = min(c.ap_per_bid, c.ap_balance)
                    c.ap_balance -= ap_spent

            satisfaction = 78 if sold < len(candidates) else 88
            if len(candidates) > 0 and sold < len(candidates):
                rej = (len(candidates) - sold) / len(candidates)
                satisfaction -= min(rej * 8, 12)

            phase_result.update({"sold": sold, "fill_pct": sold / max(seats, 1) * 100,
                                "avg_satisfaction": round(satisfaction, 1)})

        elif mode == "QUEUE":
            candidates = remaining_pool[:int(len(remaining_pool) * 0.5)]
            random.shuffle(candidates)  # 랜덤 큐!
            phase_result["applicants"] = len(candidates)

            sold = min(seats, len(candidates))
            for i in range(sold):
                w = candidates[i]
                w.total_wins += 1
                w.tickets_bought += 1
                w.consecutive_losses = 0
                w.recent_wins.append((day, event.artist, event.genre))
                max_discount = int(BOOKING_FEE * MAX_DISCOUNT_RATE)
                discount = min(w.ap_balance, max_discount)
                w.ap_balance -= discount
                w.total_fee_discount += discount
                w.total_fee_paid += (BOOKING_FEE - discount)
                if w in remaining_pool:
                    remaining_pool.remove(w)

            for i in range(sold, len(candidates)):
                candidates[i].consecutive_losses += 1

            satisfaction = 73 if sold >= seats * 0.95 else 80

            phase_result.update({"sold": sold, "fill_pct": sold / max(seats, 1) * 100,
                                "avg_satisfaction": round(satisfaction, 1)})

        elif mode == "FCFS":
            candidates = remaining_pool[:int(len(remaining_pool) * 0.3)]
            phase_result["applicants"] = len(candidates)

            sold = min(seats, len(candidates))
            for i in range(sold):
                w = candidates[i]
                w.tickets_bought += 1
                w.recent_wins.append((day, event.artist, event.genre))
                max_discount = int(BOOKING_FEE * MAX_DISCOUNT_RATE)
                discount = min(w.ap_balance, max_discount)
                w.ap_balance -= discount
                w.total_fee_discount += discount
                w.total_fee_paid += (BOOKING_FEE - discount)
                if w in remaining_pool:
                    remaining_pool.remove(w)

            satisfaction = 70 if sold >= seats * 0.9 else 78

            phase_result.update({"sold": sold, "fill_pct": sold / max(seats, 1) * 100,
                                "avg_satisfaction": round(satisfaction, 1)})

        total_sold += phase_result["sold"]
        results["phases"].append(phase_result)

    # WAITLIST
    cancels = int(total_sold * event.cancel_rate)
    waitlist_demand = int(len(all_interested) * 0.2)
    waitlist_filled = min(cancels, waitlist_demand)

    results["total_sold"] = total_sold
    results["fill_pct"] = total_sold / max(event.capacity, 1) * 100
    results["waitlist"] = {"cancels": cancels, "filled": waitlist_filled,
                           "success_pct": waitlist_filled / max(cancels, 1) * 100}
    results["unfulfilled_demand"] = max(0, len(all_interested) - total_sold)

    return results


# ═══════════════════════════════════════════════════════════════
# 시뮬 2: 연간 종합 (12개월, 월 2회 이벤트)
# ═══════════════════════════════════════════════════════════════

def run_annual_simulation():
    print("=" * 85)
    print("시뮬 1: 연간 종합 — 10,000 유저 × 24 이벤트 × 12개월")
    print("=" * 85)

    NUM_USERS = 10000
    users = create_population(NUM_USERS)

    event_results = []

    for month in range(12):
        # 월간 AP 적립
        for u in users:
            earned = int(u.monthly_ap_earn * random.uniform(0.8, 1.2))
            u.ap_balance += earned
            u.total_ap_earned += earned

        # 1년 소멸 (간이: 12개월 후 초기 잔고 소멸)
        if month == 11:
            for u in users:
                expired = int(u.total_ap_earned * 0.3)  # 약 30% 소멸 (간이 추정)
                u.ap_balance = max(0, u.ap_balance - expired)
                u.total_ap_expired += expired

        # 신규 부스트 해제 (3개월 후)
        if month == 3:
            for u in users:
                if u.is_newbie:
                    u.is_newbie = False

        # 월 2회 이벤트
        for ev_idx in range(2):
            event = EVENTS[(month * 2 + ev_idx) % len(EVENTS)]
            day = month * 30 + ev_idx * 15
            result = simulate_event(event, users, day)
            event_results.append(result)

        # 60일 지난 기록 정리
        current_day = month * 30 + 30
        for u in users:
            u.recent_wins = [(d, a, g) for d, a, g in u.recent_wins if current_day - d <= 60]

    # ─── 이벤트별 결과 출력 ───
    print(f"\n{'━' * 85}")
    print(f"  {'이벤트':<28} {'수용':>7} {'수요':>8} {'매진율':>6} {'단계별 판매':>30} {'대기열':>8}")
    print(f"{'━' * 85}")

    for r in event_results:
        phases_str = " → ".join(f"{p['mode']}:{p['sold']:,}" for p in r["phases"])
        wl = r["waitlist"]
        print(f"  {r['event']:<28} {r['capacity']:>6,} {r['demand']:>7,} {r['fill_pct']:>5.0f}% {phases_str:>30} {wl['filled']:>4}/{wl['cancels']}")

    # ─── 세그먼트별 연간 리포트 ───
    print(f"\n\n{'=' * 85}")
    print(f"시뮬 2: 소비자 계층별 연간 리포트")
    print(f"{'=' * 85}")

    print(f"\n{'세그먼트':<18} {'총응모':>6} {'당첨':>5} {'당첨률':>6} {'구매':>5} {'수수료납부':>10} {'수수료할인':>10} {'잔여AP':>8} {'소멸AP':>8}")
    print(f"{'─' * 85}")

    for seg_key in ["whale", "active", "regular", "light", "newbie"]:
        info = SEGMENTS[seg_key]
        seg_users = [u for u in users if u.segment == seg_key]
        if not seg_users:
            continue

        total_bids = sum(u.total_bids for u in seg_users)
        total_wins = sum(u.total_wins for u in seg_users)
        total_tickets = sum(u.tickets_bought for u in seg_users)
        total_fee = sum(u.total_fee_paid for u in seg_users)
        total_discount = sum(u.total_fee_discount for u in seg_users)
        avg_balance = statistics.mean([u.ap_balance for u in seg_users])
        total_expired = sum(u.total_ap_expired for u in seg_users)
        rate = total_wins / max(total_bids, 1) * 100

        count = len(seg_users)
        print(f"{info['label']:<18} {total_bids:>6,} {total_wins:>5,} {rate:>5.1f}% {total_tickets:>5,} {total_fee:>9,}원 {total_discount:>9,}원 {avg_balance:>7,.0f} {total_expired:>7,}")

    # ─── 개인별 당첨 분포 ───
    print(f"\n\n{'=' * 85}")
    print(f"시뮬 3: 개인별 당첨 분포 (공정성 검증)")
    print(f"{'=' * 85}")

    print(f"\n{'세그먼트':<18} {'0회':>8} {'1회':>8} {'2회':>8} {'3회+':>8} {'최대':>5} {'평균':>6}")
    print(f"{'─' * 65}")

    for seg_key in ["whale", "active", "regular", "light", "newbie"]:
        info = SEGMENTS[seg_key]
        seg_users = [u for u in users if u.segment == seg_key]
        wins = [u.total_wins for u in seg_users]
        n = len(seg_users)
        if n == 0:
            continue

        z = sum(1 for w in wins if w == 0)
        o = sum(1 for w in wins if w == 1)
        t = sum(1 for w in wins if w == 2)
        tp = sum(1 for w in wins if w >= 3)
        mx = max(wins)
        avg = statistics.mean(wins)

        print(f"{info['label']:<18} {z:>4}({z/n*100:>3.0f}%) {o:>4}({o/n*100:>3.0f}%) {t:>4}({t/n*100:>3.0f}%) {tp:>4}({tp/n*100:>3.0f}%) {mx:>5} {avg:>5.2f}")

    # ─── AP 경제 분석 ───
    print(f"\n\n{'=' * 85}")
    print(f"시뮬 4: AP 경제 분석")
    print(f"{'=' * 85}")

    total_ap_earned = sum(u.total_ap_earned for u in users)
    total_ap_expired = sum(u.total_ap_expired for u in users)
    total_fee_discount = sum(u.total_fee_discount for u in users)
    total_fee_paid = sum(u.total_fee_paid for u in users)
    total_tickets = sum(u.tickets_bought for u in users)

    print(f"\n  총 AP 적립:      {total_ap_earned:>15,} AP")
    print(f"  총 AP 소멸:      {total_ap_expired:>15,} AP ({total_ap_expired/max(total_ap_earned,1)*100:.1f}%)")
    print(f"  총 수수료 할인:  {total_fee_discount:>15,}원")
    print(f"  총 수수료 납부:  {total_fee_paid:>15,}원")
    print(f"  총 티켓 판매:    {total_tickets:>15,}건")
    print(f"  건당 실질 수수료:{total_fee_paid / max(total_tickets, 1):>15,.0f}원 (정가 {BOOKING_FEE:,}원, 할인상한 {MAX_DISCOUNT_RATE*100:.0f}%)")
    print(f"  수수료 할인율:   {total_fee_discount / max(total_fee_discount + total_fee_paid, 1) * 100:>14.1f}%")
    print(f"  최소 실결제:     {int(BOOKING_FEE * (1 - MAX_DISCOUNT_RATE)):>15,}원/건")

    # ─── 주최자 관점 ───
    print(f"\n\n{'=' * 85}")
    print(f"시뮬 5: 주최자 관점 — 이벤트 유형별 평가")
    print(f"{'=' * 85}")

    # 이벤트별 집계
    event_summary = defaultdict(lambda: {
        "count": 0, "capacity": 0, "sold": 0, "waitlist_filled": 0,
        "waitlist_cancels": 0, "satisfaction": [],
    })

    for r in event_results:
        key = r["event"]
        s = event_summary[key]
        s["count"] += 1
        s["capacity"] += r["capacity"]
        s["sold"] += r["total_sold"]
        s["waitlist_filled"] += r["waitlist"]["filled"]
        s["waitlist_cancels"] += r["waitlist"]["cancels"]
        for p in r["phases"]:
            s["satisfaction"].append(p["avg_satisfaction"])

    print(f"\n{'이벤트':<28} {'횟수':>4} {'매진율':>6} {'평균만족':>8} {'대기열 재배정':>14}")
    print(f"{'─' * 68}")

    for key, s in event_summary.items():
        fill = s["sold"] / max(s["capacity"], 1) * 100
        avg_sat = statistics.mean(s["satisfaction"]) if s["satisfaction"] else 0
        wl = f"{s['waitlist_filled']}/{s['waitlist_cancels']}"
        print(f"{key:<28} {s['count']:>4} {fill:>5.0f}% {avg_sat:>7.1f}점 {wl:>14}")

    # ─── 모드별 성과 집계 ───
    print(f"\n\n{'=' * 85}")
    print(f"시뮬 6: 판매모드별 성과 집계")
    print(f"{'=' * 85}")

    mode_stats = defaultdict(lambda: {"seats": 0, "sold": 0, "applicants": 0, "satisfaction": []})
    for r in event_results:
        for p in r["phases"]:
            m = mode_stats[p["mode"]]
            m["seats"] += p["seats"]
            m["sold"] += p["sold"]
            m["applicants"] += p["applicants"]
            m["satisfaction"].append(p["avg_satisfaction"])

    print(f"\n{'모드':<16} {'총좌석':>8} {'총판매':>8} {'매진율':>6} {'총응모':>9} {'경쟁률':>6} {'평균만족':>8}")
    print(f"{'─' * 68}")

    mode_order = ["MEMBERSHIP", "LOTTERY", "QUEUE", "FCFS"]
    mode_labels = {"MEMBERSHIP": "멤버십 선판매", "LOTTERY": "공정 추첨",
                   "QUEUE": "대기열 판매", "FCFS": "잔여 선착순"}

    for mode in mode_order:
        if mode not in mode_stats:
            continue
        s = mode_stats[mode]
        fill = s["sold"] / max(s["seats"], 1) * 100
        comp = s["applicants"] / max(s["sold"], 1)
        avg_sat = statistics.mean(s["satisfaction"]) if s["satisfaction"] else 0
        label = mode_labels[mode]
        print(f"{label:<16} {s['seats']:>7,} {s['sold']:>7,} {fill:>5.0f}% {s['applicants']:>8,} {comp:>5.1f}:1 {avg_sat:>7.1f}점")

    # ─── 세그먼트 × 모드 교차 분석 ───
    print(f"\n\n{'=' * 85}")
    print(f"시뮬 7: 세그먼트 × 모드 접근성 매트릭스")
    print(f"{'=' * 85}")

    print(f"\n  멤버십 선판매: 멤버십 필수 → 고래/열성만 참여 가능")
    print(f"  공정 추첨:    전체 참여 가능 + AP 가중치 → 활동량 반영")
    print(f"  대기열 판매:  전체 참여 + 완전 랜덤 → 가장 균등")
    print(f"  잔여 선착순:  전체 참여 + 속도 기반 → 봇 취약하나 잔여석만")

    print(f"\n{'세그먼트':<18}", end="")
    for mode in mode_order:
        print(f" {mode_labels[mode]:>12}", end="")
    print()
    print(f"{'─' * 68}")

    access = {
        "whale":   {"MEMBERSHIP": "◎ 최우선", "LOTTERY": "◎ AP 최대", "QUEUE": "○ 동등", "FCFS": "○ 동등"},
        "active":  {"MEMBERSHIP": "◎ 우선",   "LOTTERY": "○ AP 보통", "QUEUE": "○ 동등", "FCFS": "○ 동등"},
        "regular": {"MEMBERSHIP": "✕ 불가",   "LOTTERY": "○ AP 보통", "QUEUE": "○ 동등", "FCFS": "○ 동등"},
        "light":   {"MEMBERSHIP": "✕ 불가",   "LOTTERY": "△ AP 낮음", "QUEUE": "○ 동등", "FCFS": "○ 동등"},
        "newbie":  {"MEMBERSHIP": "✕ 불가",   "LOTTERY": "○ 부스트",  "QUEUE": "○ 동등", "FCFS": "○ 동등"},
    }

    for seg_key in ["whale", "active", "regular", "light", "newbie"]:
        info = SEGMENTS[seg_key]
        print(f"{info['label']:<18}", end="")
        for mode in mode_order:
            print(f" {access[seg_key][mode]:>12}", end="")
        print()

    # ─── 수수료 경제 시나리오 ───
    print(f"\n\n{'=' * 85}")
    print(f"시뮬 8: 수수료 경제 — AP 할인 도입 전 vs 후")
    print(f"{'=' * 85}")

    fee_no_discount = total_tickets * BOOKING_FEE
    fee_with_discount = total_fee_paid

    print(f"\n  {'항목':<24} {'AP할인 없음':>14} {'AP할인 있음':>14} {'변화':>10}")
    print(f"  {'─' * 66}")
    print(f"  {'총 티켓 판매':<24} {total_tickets:>13,}건 {total_tickets:>13,}건 {'—':>10}")
    print(f"  {'수수료 수입':<24} {fee_no_discount:>12,}원 {fee_with_discount:>12,}원 {(fee_with_discount - fee_no_discount) / fee_no_discount * 100:>+9.1f}%")
    print(f"  {'건당 실질 수수료':<24} {BOOKING_FEE:>12,}원 {total_fee_paid // max(total_tickets, 1):>12,}원 {'':>10}")
    print(f"  {'유저 절약 총액':<24} {'0':>13}원 {total_fee_discount:>12,}원 {'':>10}")

    # ─── 최종 종합 점수 ───
    print(f"\n\n{'=' * 85}")
    print(f"최종 종합 평가")
    print(f"{'=' * 85}")

    # 공정성 (지니계수 기반)
    all_wins = [u.total_wins for u in users if u.total_bids > 0]
    all_wins.sort()
    n = len(all_wins)
    s = sum(all_wins)
    gini = 0
    if n > 0 and s > 0:
        gini = sum((2 * (i + 1) - n - 1) * x for i, x in enumerate(all_wins)) / (n * s)

    # 세그먼트 격차
    seg_rates = {}
    for seg_key in SEGMENTS:
        seg_u = [u for u in users if u.segment == seg_key and u.total_bids > 0]
        if seg_u:
            seg_rates[seg_key] = sum(u.total_wins for u in seg_u) / sum(u.total_bids for u in seg_u)
    max_rate = max(seg_rates.values()) if seg_rates else 0
    min_rate = min(seg_rates.values()) if seg_rates else 0
    rate_gap = max_rate / max(min_rate, 0.001)

    total_fill = sum(r["total_sold"] for r in event_results) / sum(r["capacity"] for r in event_results) * 100

    monopolists = sum(1 for u in users if u.total_wins >= 4)
    zero_bidders = sum(1 for u in users if u.total_bids > 0 and u.total_wins == 0)
    total_bidders = sum(1 for u in users if u.total_bids > 0)

    print(f"""
  ┌─────────────────────────────────────────────────────┐
  │ 공정성                                               │
  │   지니계수:           {gini:.4f}                       │
  │   세그먼트 당첨률 격차: {rate_gap:.2f}배 (최대/최소)      │
  │   3회+ 독식자:        {monopolists}명                   │
  │   응모 후 0회 당첨:    {zero_bidders}/{total_bidders} ({zero_bidders/max(total_bidders,1)*100:.1f}%)   │
  ├─────────────────────────────────────────────────────┤
  │ 운영                                                 │
  │   전체 매진율:        {total_fill:.1f}%                 │
  │   대기열 재배정:      {sum(r['waitlist']['filled'] for r in event_results)}/{sum(r['waitlist']['cancels'] for r in event_results)}건    │
  ├─────────────────────────────────────────────────────┤
  │ 경제                                                 │
  │   수수료 수입:        {fee_with_discount:,}원           │
  │   유저 절약:          {total_fee_discount:,}원          │
  │   건당 실질 수수료:    {total_fee_paid // max(total_tickets, 1):,}원 (정가 {BOOKING_FEE:,}원, 할인상한 {MAX_DISCOUNT_RATE*100:.0f}%)   │
  └─────────────────────────────────────────────────────┘
""")


if __name__ == "__main__":
    run_annual_simulation()
    print("시뮬레이션 완료")
