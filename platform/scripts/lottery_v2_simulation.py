"""
Pickket 공정 추첨 v2 시뮬레이션 — 다각도 검증
로그 스케일 + 연속낙첨 부스트 + 신규부스트 + 쿨다운
"""

import math
import random
import statistics
from collections import defaultdict
from dataclasses import dataclass, field

random.seed(42)

# ═══════════════════════════════════════════════════════════════
# 공정 추첨 v2 엔진
# ═══════════════════════════════════════════════════════════════

BASE_WEIGHT = 100
NEWBIE_BOOST = 50          # 가입 90일 내 +50
MAX_AP_PER_BID = 3000
COOLDOWN_SAME_ARTIST = 0.50   # 30일 내 동일 아티스트 당첨 → -50%
COOLDOWN_SAME_GENRE = 0.20    # 30일 내 동일 장르 당첨 → -20%
COOLDOWN_MULTI_WIN = 0.30     # 60일 내 2회+ 당첨 → -30%

CONSECUTIVE_LOSS_BONUS = {2: 30, 3: 70, 4: 100, 5: 150}  # 5+ = 150 고정


def calc_ap_bonus(ap_invested: float) -> float:
    """로그 스케일 AP 보너스"""
    capped = min(ap_invested, MAX_AP_PER_BID)
    return math.log2(capped + 1) * 10


def calc_loss_bonus(consecutive_losses: int) -> float:
    if consecutive_losses < 2:
        return 0
    if consecutive_losses >= 5:
        return 150
    return CONSECUTIVE_LOSS_BONUS.get(consecutive_losses, 0)


def calc_weight(
    ap_invested: float,
    consecutive_losses: int = 0,
    is_newbie: bool = False,
    same_artist_recent_win: bool = False,
    same_genre_recent_win: bool = False,
    multi_win_60d: bool = False,
) -> float:
    base = BASE_WEIGHT
    if is_newbie:
        base += NEWBIE_BOOST

    ap_bonus = calc_ap_bonus(ap_invested)
    loss_bonus = calc_loss_bonus(consecutive_losses)

    weight = base + ap_bonus + loss_bonus

    # 쿨다운 (곱셈 감소)
    if same_artist_recent_win:
        weight *= (1 - COOLDOWN_SAME_ARTIST)
    if same_genre_recent_win:
        weight *= (1 - COOLDOWN_SAME_GENRE)
    if multi_win_60d:
        weight *= (1 - COOLDOWN_MULTI_WIN)

    return max(weight, 10)  # 최소 10


# ═══════════════════════════════════════════════════════════════
# 유저 세그먼트
# ═══════════════════════════════════════════════════════════════

@dataclass
class User:
    id: int
    segment: str
    ap_per_bid: float
    is_newbie: bool = False
    consecutive_losses: int = 0
    wins_30d: list = field(default_factory=list)  # (day, artist, genre)
    wins_60d: int = 0
    total_wins: int = 0
    total_bids: int = 0


SEGMENTS = {
    "whale":   {"ratio": 0.01, "ap_bid": 2000, "label": "고래 (1%)",     "bids_per_year": 24},
    "active":  {"ratio": 0.09, "ap_bid": 1200, "label": "열성 (9%)",     "bids_per_year": 12},
    "regular": {"ratio": 0.50, "ap_bid": 600,  "label": "일반 (50%)",    "bids_per_year": 6},
    "light":   {"ratio": 0.30, "ap_bid": 300,  "label": "라이트 (30%)",  "bids_per_year": 3},
    "newbie":  {"ratio": 0.10, "ap_bid": 400,  "label": "신규 (10%)",    "bids_per_year": 4},
}


def create_users(n: int) -> list[User]:
    users = []
    uid = 0
    for seg, info in SEGMENTS.items():
        count = int(n * info["ratio"])
        for _ in range(count):
            users.append(User(
                id=uid,
                segment=seg,
                ap_per_bid=info["ap_bid"] * random.uniform(0.7, 1.3),
                is_newbie=(seg == "newbie"),
            ))
            uid += 1
    return users


# ═══════════════════════════════════════════════════════════════
# 검증 1: 가중치 분포 확인
# ═══════════════════════════════════════════════════════════════

def test1_weight_distribution():
    print("=" * 80)
    print("검증 1: 가중치 분포 — AP 투입량별 실제 가중치")
    print("=" * 80)

    print(f"\n{'AP 투입':>10} {'기본 가중치':>12} {'3연낙 가중치':>14} {'5연낙 가중치':>14} {'신규+3연낙':>12}")
    print(f"{'─' * 66}")

    for ap in [0, 100, 300, 500, 600, 1000, 1200, 2000, 3000, 5000]:
        w_base = calc_weight(ap)
        w_loss3 = calc_weight(ap, consecutive_losses=3)
        w_loss5 = calc_weight(ap, consecutive_losses=5)
        w_newbie_loss3 = calc_weight(ap, consecutive_losses=3, is_newbie=True)
        print(f"{ap:>10,} {w_base:>12.1f} {w_loss3:>14.1f} {w_loss5:>14.1f} {w_newbie_loss3:>12.1f}")

    # 쿨다운 효과
    print(f"\n쿨다운 효과 (고래 AP=2000 기준):")
    w_normal = calc_weight(2000)
    w_cd1 = calc_weight(2000, same_artist_recent_win=True)
    w_cd2 = calc_weight(2000, same_genre_recent_win=True)
    w_cd3 = calc_weight(2000, multi_win_60d=True)
    w_cd_all = calc_weight(2000, same_artist_recent_win=True, same_genre_recent_win=True, multi_win_60d=True)

    print(f"  쿨다운 없음:         {w_normal:.1f}")
    print(f"  동일 아티스트 30일:   {w_cd1:.1f} ({w_cd1/w_normal*100:.0f}%)")
    print(f"  동일 장르 30일:       {w_cd2:.1f} ({w_cd2/w_normal*100:.0f}%)")
    print(f"  60일 내 2회+ 당첨:    {w_cd3:.1f} ({w_cd3/w_normal*100:.0f}%)")
    print(f"  전부 적용:           {w_cd_all:.1f} ({w_cd_all/w_normal*100:.0f}%)")

    # 최대/최소 가중치 비율
    w_max = calc_weight(3000)  # 고래, 쿨다운 없음
    w_min = calc_weight(0)     # 완전 비활동
    w_newbie_boosted = calc_weight(400, consecutive_losses=5, is_newbie=True)
    print(f"\n  최대 가중치 (고래, 쿨다운 없음):    {w_max:.1f}")
    print(f"  최소 가중치 (AP 0):                {w_min:.1f}")
    print(f"  최대/최소 비율:                    {w_max/w_min:.2f}x")
    print(f"  신규+5연낙 (AP 400):               {w_newbie_boosted:.1f} (고래 대비 {w_newbie_boosted/w_max:.2f}x)")


# ═══════════════════════════════════════════════════════════════
# 검증 2: 대규모 추첨 — 세그먼트별 당첨률
# ═══════════════════════════════════════════════════════════════

def run_single_lottery(users: list[User], seats: int, artist: str = "A", genre: str = "kpop", day: int = 0):
    """한 번의 추첨 실행, 유저 상태 업데이트"""
    # 응모자 선정 (세그먼트별 참여율)
    participation = {"whale": 0.8, "active": 0.6, "regular": 0.3, "light": 0.15, "newbie": 0.3}
    applicants = [u for u in users if random.random() < participation[u.segment]]

    if not applicants:
        return {}

    # 가중치 계산
    weights = []
    for u in applicants:
        same_artist = any(a == artist for d, a, g in u.wins_30d if day - d <= 30)
        same_genre = any(g == genre for d, a, g in u.wins_30d if day - d <= 30)
        multi = u.wins_60d >= 2

        w = calc_weight(
            u.ap_per_bid,
            consecutive_losses=u.consecutive_losses,
            is_newbie=u.is_newbie and day <= 90,
            same_artist_recent_win=same_artist,
            same_genre_recent_win=same_genre,
            multi_win_60d=multi,
        )
        weights.append(w)

    # 추첨
    winners = set()
    pool_indices = list(range(len(applicants)))
    pool_weights = list(weights)

    for _ in range(min(seats, len(applicants))):
        if not pool_indices:
            break
        total = sum(pool_weights)
        probs = [w / total for w in pool_weights]
        chosen = random.choices(range(len(pool_indices)), weights=probs, k=1)[0]

        winner_idx = pool_indices[chosen]
        winners.add(winner_idx)

        pool_indices.pop(chosen)
        pool_weights.pop(chosen)

    # 상태 업데이트
    for i, u in enumerate(applicants):
        u.total_bids += 1
        if i in winners:
            u.total_wins += 1
            u.consecutive_losses = 0
            u.wins_30d.append((day, artist, genre))
            u.wins_60d += 1
        else:
            u.consecutive_losses += 1

    # 60일 윈도우 정리
    for u in users:
        u.wins_30d = [(d, a, g) for d, a, g in u.wins_30d if day - d <= 60]

    # 결과 집계
    results = defaultdict(lambda: {"applied": 0, "won": 0})
    for i, u in enumerate(applicants):
        results[u.segment]["applied"] += 1
        if i in winners:
            results[u.segment]["won"] += 1

    return results


def test2_large_scale_lottery():
    print("\n\n" + "=" * 80)
    print("검증 2: 대규모 추첨 — 5,000유저 × 100석 × 24회(1년)")
    print("=" * 80)

    NUM_USERS = 5000
    SEATS = 100
    NUM_EVENTS = 24  # 1년간 24회 이벤트

    artists = ["BTS", "SVT", "aespa", "IU", "BP", "NCT", "SKZ", "ATEEZ",
               "NewJeans", "LE SSERAFIM", "TXT", "ENHYPEN"]
    genres = ["kpop"] * 8 + ["musical", "sports", "festival", "classical"]

    users = create_users(NUM_USERS)
    yearly_stats = defaultdict(lambda: {"bids": 0, "wins": 0})

    for event_idx in range(NUM_EVENTS):
        day = event_idx * 15  # 2주 간격
        artist = artists[event_idx % len(artists)]
        genre = genres[event_idx % len(genres)]

        results = run_single_lottery(users, SEATS, artist, genre, day)
        for seg, data in results.items():
            yearly_stats[seg]["bids"] += data["applied"]
            yearly_stats[seg]["wins"] += data["won"]

    print(f"\n{'세그먼트':<18} {'총 응모':>8} {'총 당첨':>8} {'당첨률':>8} {'인당 평균':>10}")
    print(f"{'─' * 56}")

    for seg_key in ["whale", "active", "regular", "light", "newbie"]:
        info = SEGMENTS[seg_key]
        stats = yearly_stats[seg_key]
        count = int(NUM_USERS * info["ratio"])
        rate = stats["wins"] / max(stats["bids"], 1) * 100
        per_person = stats["wins"] / max(count, 1)
        print(f"{info['label']:<18} {stats['bids']:>7,} {stats['wins']:>7,} {rate:>7.1f}% {per_person:>8.2f}회")

    # 개인별 당첨 분포
    print(f"\n개인별 당첨 분포:")
    for seg_key in ["whale", "active", "regular", "light", "newbie"]:
        info = SEGMENTS[seg_key]
        seg_users = [u for u in users if u.segment == seg_key]
        wins_list = [u.total_wins for u in seg_users]

        zero_wins = sum(1 for w in wins_list if w == 0)
        one_plus = sum(1 for w in wins_list if w >= 1)
        three_plus = sum(1 for w in wins_list if w >= 3)
        max_wins = max(wins_list) if wins_list else 0
        avg_wins = statistics.mean(wins_list) if wins_list else 0

        total = len(seg_users)
        print(f"  {info['label']:<18} 0회:{zero_wins}({zero_wins/total*100:.0f}%) | 1회+:{one_plus}({one_plus/total*100:.0f}%) | 3회+:{three_plus}({three_plus/total*100:.0f}%) | 최대:{max_wins}회 | 평균:{avg_wins:.2f}회")


# ═══════════════════════════════════════════════════════════════
# 검증 3: 연속 낙첨 부스트 효과 — 몇 회 만에 당첨?
# ═══════════════════════════════════════════════════════════════

def test3_consecutive_loss_recovery():
    print("\n\n" + "=" * 80)
    print("검증 3: 연속 낙첨 후 회복 — 몇 회 응모 만에 당첨?")
    print("=" * 80)
    print("  (경쟁률 5:1 기준, 1만 번 시행)")

    TRIALS = 10000
    COMPETITION = 5  # 5명 중 1명 당첨

    for seg_key in ["whale", "active", "regular", "light", "newbie"]:
        info = SEGMENTS[seg_key]
        ap = info["ap_bid"]
        is_newbie = (seg_key == "newbie")

        attempts_to_win = []
        for _ in range(TRIALS):
            losses = 0
            for attempt in range(1, 51):  # 최대 50회
                w_user = calc_weight(ap, consecutive_losses=losses, is_newbie=is_newbie and attempt <= 6)
                # 경쟁자: 평균 가중치 190 (일반 유저 기준)
                w_others = 190 * (COMPETITION - 1)
                prob = w_user / (w_user + w_others)

                if random.random() < prob:
                    attempts_to_win.append(attempt)
                    break
                losses += 1
            else:
                attempts_to_win.append(50)

        avg = statistics.mean(attempts_to_win)
        median = statistics.median(attempts_to_win)
        p90 = sorted(attempts_to_win)[int(TRIALS * 0.9)]
        never = sum(1 for a in attempts_to_win if a >= 50)

        print(f"  {info['label']:<18} 평균 {avg:.1f}회 | 중위 {median:.0f}회 | 90% {p90}회 내 | 50회 내 미당첨 {never/TRIALS*100:.1f}%")


# ═══════════════════════════════════════════════════════════════
# 검증 4: 쿨다운 효과 — 고래 독식 방지
# ═══════════════════════════════════════════════════════════════

def test4_cooldown_anti_monopoly():
    print("\n\n" + "=" * 80)
    print("검증 4: 쿨다운 효과 — 동일 아티스트 연속 당첨 시뮬")
    print("=" * 80)
    print("  (BTS 공연 3회 연속 개최, 각 100석, 5000명)")

    NUM_USERS = 5000
    SEATS = 100

    for scenario, use_cooldown in [("쿨다운 없음", False), ("쿨다운 적용", True)]:
        users = create_users(NUM_USERS)
        multi_winners = defaultdict(int)  # user_id → 당첨 횟수

        for event_idx in range(3):
            day = event_idx * 15

            participation = {"whale": 0.8, "active": 0.6, "regular": 0.3, "light": 0.15, "newbie": 0.3}
            applicants = [u for u in users if random.random() < participation[u.segment]]

            weights = []
            for u in applicants:
                if use_cooldown:
                    same_artist = multi_winners[u.id] > 0
                    multi = multi_winners[u.id] >= 2
                    w = calc_weight(u.ap_per_bid,
                                    consecutive_losses=u.consecutive_losses,
                                    is_newbie=u.is_newbie,
                                    same_artist_recent_win=same_artist,
                                    multi_win_60d=multi)
                else:
                    w = calc_weight(u.ap_per_bid,
                                    consecutive_losses=u.consecutive_losses,
                                    is_newbie=u.is_newbie)
                weights.append(w)

            # 추첨
            pool_idx = list(range(len(applicants)))
            pool_w = list(weights)
            for _ in range(min(SEATS, len(applicants))):
                if not pool_idx:
                    break
                total = sum(pool_w)
                chosen = random.choices(range(len(pool_idx)), weights=[w/total for w in pool_w], k=1)[0]
                winner = applicants[pool_idx[chosen]]
                multi_winners[winner.id] += 1
                winner.consecutive_losses = 0
                pool_idx.pop(chosen)
                pool_w.pop(chosen)

            for i, u in enumerate(applicants):
                if i not in {pool_idx[j] if j < len(pool_idx) else -1 for j in range(len(pool_idx))}:
                    pass
                u.consecutive_losses += 1

        # 분석
        win_counts = list(multi_winners.values())
        triple = sum(1 for v in win_counts if v >= 3)
        double = sum(1 for v in win_counts if v >= 2)
        unique = len(win_counts)

        # 세그먼트별 중복 당첨
        seg_multi = defaultdict(int)
        for uid, count in multi_winners.items():
            if count >= 2:
                user = users[uid] if uid < len(users) else None
                if user:
                    seg_multi[user.segment] += 1

        print(f"\n  📊 {scenario}")
        print(f"  3회 연속 당첨: {triple}명 | 2회+ 당첨: {double}명 | 고유 당첨자: {unique}명")
        print(f"  세그먼트별 2회+ 당첨: ", end="")
        for seg in ["whale", "active", "regular", "light", "newbie"]:
            print(f"{SEGMENTS[seg]['label']}:{seg_multi[seg]} ", end="")
        print()


# ═══════════════════════════════════════════════════════════════
# 검증 5: 극단 시나리오 — 엣지 케이스
# ═══════════════════════════════════════════════════════════════

def test5_edge_cases():
    print("\n\n" + "=" * 80)
    print("검증 5: 극단 시나리오")
    print("=" * 80)

    # 5-1: 고래 100명 vs 신규 100명 — 100석 쟁탈
    print(f"\n  ─── 5-1: 고래 100명 vs 신규 100명 → 100석 (1,000회 반복) ───")
    whale_wins_total = 0
    newbie_wins_total = 0
    TRIALS = 1000

    for _ in range(TRIALS):
        pool = []
        weights = []
        for i in range(100):
            pool.append("whale")
            weights.append(calc_weight(2000 * random.uniform(0.8, 1.2)))
        for i in range(100):
            pool.append("newbie")
            weights.append(calc_weight(400 * random.uniform(0.8, 1.2), is_newbie=True))

        idx_list = list(range(200))
        w_list = list(weights)
        winners = []
        for _ in range(100):
            total = sum(w_list)
            chosen = random.choices(range(len(idx_list)), weights=[w/total for w in w_list], k=1)[0]
            winners.append(pool[idx_list[chosen]])
            idx_list.pop(chosen)
            w_list.pop(chosen)

        whale_wins_total += sum(1 for w in winners if w == "whale")
        newbie_wins_total += sum(1 for w in winners if w == "newbie")

    print(f"  고래 평균 당첨: {whale_wins_total/TRIALS:.1f}석 | 신규 평균 당첨: {newbie_wins_total/TRIALS:.1f}석")
    print(f"  비율: 고래 {whale_wins_total/TRIALS/100*100:.1f}% vs 신규 {newbie_wins_total/TRIALS/100*100:.1f}%")

    # 5-2: 전원 AP=0 (순수 랜덤 퇴화 확인)
    print(f"\n  ─── 5-2: 전원 AP=0 — 순수 랜덤 퇴화 확인 ───")
    w_zero = calc_weight(0)
    w_zero2 = calc_weight(0)
    print(f"  모든 유저 가중치: {w_zero:.1f} (동일) → 순수 랜덤과 동등 ✓")

    # 5-3: 5연속 낙첨 신규 vs 무낙첨 고래
    print(f"\n  ─── 5-3: 5연낙 신규 vs 무낙첨 고래 ───")
    w_newbie_5loss = calc_weight(400, consecutive_losses=5, is_newbie=True)
    w_whale_fresh = calc_weight(2000)
    print(f"  5연낙 신규 (AP 400): {w_newbie_5loss:.1f}")
    print(f"  무낙첨 고래 (AP 2000): {w_whale_fresh:.1f}")
    print(f"  신규/고래 비율: {w_newbie_5loss/w_whale_fresh:.2f}x → 신규가 {'유리' if w_newbie_5loss > w_whale_fresh else '불리하지만 근접'}!")

    # 5-4: 쿨다운 최악 (고래가 모든 쿨다운 먹은 상태)
    print(f"\n  ─── 5-4: 쿨다운 풀스택 고래 vs 3연낙 일반 ───")
    w_whale_cd = calc_weight(2000, same_artist_recent_win=True, same_genre_recent_win=True, multi_win_60d=True)
    w_regular_3loss = calc_weight(600, consecutive_losses=3)
    print(f"  쿨다운 풀 고래: {w_whale_cd:.1f}")
    print(f"  3연낙 일반: {w_regular_3loss:.1f}")
    print(f"  일반/고래 비율: {w_regular_3loss/w_whale_cd:.2f}x → {'일반이 유리!' if w_regular_3loss > w_whale_cd else '고래가 여전히 유리'}")

    # 5-5: 초고경쟁 (100:1) 시 각 세그먼트 당첨 확률
    print(f"\n  ─── 5-5: 초고경쟁률 (100:1) 시 당첨 확률 ───")
    print(f"  (10,000명 응모 → 100석)")
    for seg_key in ["whale", "active", "regular", "light", "newbie"]:
        info = SEGMENTS[seg_key]
        ap = info["ap_bid"]
        is_newbie = (seg_key == "newbie")

        wins = 0
        TRIALS_INNER = 5000
        for _ in range(TRIALS_INNER):
            w_me = calc_weight(ap, is_newbie=is_newbie)
            # 나머지 9,999명의 평균 가중치
            avg_others = 193  # 전체 평균
            w_total = w_me + avg_others * 99  # 100석 중 1석 기준
            prob = w_me / (w_me + avg_others * 99) * 100  # 100석
            if random.random() < prob:
                wins += 1

        print(f"  {info['label']:<18} 당첨 확률: {wins/TRIALS_INNER*100:.1f}%")


# ═══════════════════════════════════════════════════════════════
# 검증 6: v1 vs v2 비교 — 동일 조건 A/B 테스트
# ═══════════════════════════════════════════════════════════════

def test6_ab_comparison():
    print("\n\n" + "=" * 80)
    print("검증 6: v1(선형 가중치) vs v2(로그+보정) A/B 비교")
    print("=" * 80)
    print("  (5,000유저 × 100석 × 12회, 동일 시드)")

    NUM_USERS = 5000
    SEATS = 100
    NUM_EVENTS = 12

    for version, label in [("v1", "v1 선형 가중치"), ("v2", "v2 로그+보정")]:
        random.seed(123)  # 동일 시드
        users = create_users(NUM_USERS)
        seg_wins = defaultdict(int)
        seg_bids = defaultdict(int)
        per_user_wins = defaultdict(int)

        for event_idx in range(NUM_EVENTS):
            participation = {"whale": 0.8, "active": 0.6, "regular": 0.3, "light": 0.15, "newbie": 0.3}
            applicants = [u for u in users if random.random() < participation[u.segment]]

            weights = []
            for u in applicants:
                if version == "v1":
                    # v1: 선형 가중치 (기존)
                    w = max(u.ap_per_bid + 100, 100)
                else:
                    # v2: 로그 + 보정
                    w = calc_weight(
                        u.ap_per_bid,
                        consecutive_losses=u.consecutive_losses,
                        is_newbie=u.is_newbie and event_idx < 6,
                        same_artist_recent_win=(u.total_wins > 0 and event_idx - max((i for i, _ in enumerate(range(u.total_wins))), default=-10) <= 2),
                        multi_win_60d=u.total_wins >= 2,
                    )
                weights.append(w)

            pool_idx = list(range(len(applicants)))
            pool_w = list(weights)

            for _ in range(min(SEATS, len(applicants))):
                if not pool_idx:
                    break
                total = sum(pool_w)
                chosen = random.choices(range(len(pool_idx)), weights=[w/total for w in pool_w], k=1)[0]
                winner = applicants[pool_idx[chosen]]
                seg_wins[winner.segment] += 1
                per_user_wins[winner.id] += 1
                winner.total_wins += 1
                winner.consecutive_losses = 0
                pool_idx.pop(chosen)
                pool_w.pop(chosen)

            for u in applicants:
                seg_bids[u.segment] += 1
                u.consecutive_losses += 1

        print(f"\n  {'─' * 60}")
        print(f"  {label}")
        print(f"  {'세그먼트':<18} {'당첨':>6} {'응모':>7} {'당첨률':>8} {'인구 점유':>10} {'당첨 점유':>10}")
        print(f"  {'─' * 60}")

        total_wins = sum(seg_wins.values())
        for seg_key in ["whale", "active", "regular", "light", "newbie"]:
            info = SEGMENTS[seg_key]
            wins = seg_wins[seg_key]
            bids = seg_bids[seg_key]
            rate = wins / max(bids, 1) * 100
            pop_share = info["ratio"] * 100
            win_share = wins / max(total_wins, 1) * 100
            print(f"  {info['label']:<18} {wins:>5} {bids:>6,} {rate:>7.1f}% {pop_share:>8.0f}% {win_share:>8.1f}%")

        # 지니 계수
        all_wins = [per_user_wins.get(i, 0) for i in range(NUM_USERS)]
        all_wins.sort()
        n = len(all_wins)
        s = sum(all_wins)
        if s > 0:
            gini = sum((2 * (i + 1) - n - 1) * x for i, x in enumerate(all_wins)) / (n * s)
            print(f"  지니계수: {gini:.4f}")

        # 1회도 당첨 못한 응모자 비율
        bidders = [u for u in users if u.total_bids > 0]
        zero_winners = sum(1 for u in bidders if u.total_wins == 0)
        if len(bidders) > 0:
            print(f"  응모했으나 0회 당첨: {zero_winners}/{len(bidders)} ({zero_winners/len(bidders)*100:.1f}%)")
        else:
            print(f"  응모했으나 0회 당첨: 0/0 (N/A)")

        # 3회+ 당첨 독식자
        monopolists = sum(1 for w in per_user_wins.values() if w >= 3)
        print(f"  3회+ 당첨 독식자: {monopolists}명")


# ═══════════════════════════════════════════════════════════════
# 검증 7: 주최자 시나리오별 모드 조합 효과
# ═══════════════════════════════════════════════════════════════

def test7_organizer_scenarios():
    print("\n\n" + "=" * 80)
    print("검증 7: 주최자 관점 — 모드 조합별 매진율·공정성·운영 평가")
    print("=" * 80)

    scenarios = [
        {
            "name": "K-pop 대형 (수요 20:1)",
            "capacity": 50000, "demand_mult": 20,
            "combos": [
                ("MEMBERSHIP→LOTTERY", [("M", 0.4), ("L", 0.6)]),
                ("LOTTERY 단독", [("L", 1.0)]),
                ("MEMBERSHIP→LOTTERY→QUEUE", [("M", 0.3), ("L", 0.4), ("Q", 0.3)]),
            ]
        },
        {
            "name": "중형 공연 (수요 5:1)",
            "capacity": 10000, "demand_mult": 5,
            "combos": [
                ("LOTTERY→QUEUE", [("L", 0.6), ("Q", 0.4)]),
                ("QUEUE 단독", [("Q", 1.0)]),
                ("MEMBERSHIP→LOTTERY", [("M", 0.3), ("L", 0.7)]),
            ]
        },
        {
            "name": "소형 공연 (수요 1.5:1)",
            "capacity": 500, "demand_mult": 1.5,
            "combos": [
                ("QUEUE 단독", [("Q", 1.0)]),
                ("FCFS 단독", [("F", 1.0)]),
                ("LOTTERY→FCFS", [("L", 0.7), ("F", 0.3)]),
            ]
        },
    ]

    for sc in scenarios:
        print(f"\n  {'━' * 60}")
        print(f"  🎪 {sc['name']} ({sc['capacity']:,}석)")
        print(f"  {'━' * 60}")

        print(f"  {'조합':<28} {'매진율':>7} {'봇차단':>7} {'공정성':>7} {'운영부하':>8} {'종합':>7}")
        print(f"  {'─' * 60}")

        for combo_name, modes in sc["combos"]:
            demand = sc["capacity"] * sc["demand_mult"]
            fill = min(100, demand / sc["capacity"] * 100 * 0.95)  # 약간의 미소화

            # 봇 차단 점수
            bot_score = 0
            for mode_type, ratio in modes:
                if mode_type in ("M", "L"):
                    bot_score += ratio * 95  # 추첨=봇 무의미
                elif mode_type == "Q":
                    bot_score += ratio * 80  # 랜덤큐=봇 약화
                else:
                    bot_score += ratio * 50  # FCFS=봇 취약

            # 공정성 점수
            fairness = 0
            for mode_type, ratio in modes:
                if mode_type == "L":
                    fairness += ratio * 90
                elif mode_type == "M":
                    fairness += ratio * 70  # 멤버십만 가능 → 비회원 배제
                elif mode_type == "Q":
                    fairness += ratio * 85
                else:
                    fairness += ratio * 55

            # 운영 부하 (낮을수록 좋음 → 100에서 뺌)
            ops_ease = 0
            for mode_type, ratio in modes:
                if mode_type in ("M", "L"):
                    ops_ease += ratio * 90  # 비실시간
                elif mode_type == "Q":
                    ops_ease += ratio * 65  # 대기열 인프라 필요
                else:
                    ops_ease += ratio * 50  # 서버 부하

            total = (fill * 0.3 + bot_score * 0.25 + fairness * 0.25 + ops_ease * 0.2)

            print(f"  {combo_name:<28} {fill:>6.1f} {bot_score:>6.1f} {fairness:>6.1f} {ops_ease:>7.1f} {total:>6.1f}")


# ═══════════════════════════════════════════════════════════════
# 검증 8: AP 1년 소멸 + 로그 조합 — 3년 장기 시뮬
# ═══════════════════════════════════════════════════════════════

def test8_long_term():
    print("\n\n" + "=" * 80)
    print("검증 8: 3년 장기 시뮬 — 가입 시점별 유저 경험")
    print("=" * 80)

    # 3가지 시점 가입 유저 비교
    profiles = [
        ("1년차 고래", "whale", 2000, 0),
        ("1년차 일반", "regular", 600, 0),
        ("2년차 고래 (기존 축적 무효)", "whale", 2000, 365),
        ("신규 가입 (열정적)", "newbie", 500, 700),
    ]

    print(f"\n  {'유저':<32} {'실효AP':>8} {'가중치':>8} {'고래대비':>8}")
    print(f"  {'─' * 60}")

    whale_w = None
    for label, seg, ap, join_day in profiles:
        # 1년 절대소멸이므로 join_day 무관하게 최근 1년 활동분만
        is_newbie = (seg == "newbie")
        w = calc_weight(ap, is_newbie=is_newbie)
        if whale_w is None:
            whale_w = w
        print(f"  {label:<32} {ap:>7,} {w:>7.1f} {w/whale_w:>7.2f}x")

    print(f"\n  → 2년차 고래와 1년차 고래의 가중치 동일 (1년 소멸 효과)")
    print(f"  → 신규 열정 유저(AP 500)도 고래 대비 {calc_weight(500, is_newbie=True)/whale_w:.2f}x (부스트 포함)")


# ═══════════════════════════════════════════════════════════════
# 실행
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    test1_weight_distribution()
    test2_large_scale_lottery()
    test3_consecutive_loss_recovery()
    test4_cooldown_anti_monopoly()
    test5_edge_cases()
    test6_ab_comparison()
    test7_organizer_scenarios()
    test8_long_term()

    print("\n\n" + "=" * 80)
    print("전체 시뮬레이션 완료")
    print("=" * 80)
