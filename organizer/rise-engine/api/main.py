"""RISE Engine API Server — pickket.go 프록시용"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import sys, os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from talkfile_engine.vcg import VCGEngine, AllocationInput, BidInput
from talkfile_engine.fan_weight import FanScores, compute_fan_weight_v2
from talkfile_engine.lottery import LotteryEntry, LotteryPool, run_lottery

app = FastAPI(title="RISE Engine API", version="0.1.0")
vcg_engine = VCGEngine()

# ─── Health ───

@app.get("/health")
def health():
    return {"status": "ok", "engine": "rise", "version": "0.1.0"}

# ─── VCG 경매 ───

class BidRequest(BaseModel):
    bid_id: str
    user_id: str
    max_willingness_to_pay: float
    effective_weight: float = 1.0
    quantity: int = 1

class AllocateRequest(BaseModel):
    bids: list[BidRequest]
    total_seats: int
    min_price: float = 0.0
    max_price_cap: float = 0.0
    stabilization_lambda: float = 0.0

@app.post("/allocate")
def allocate(req: AllocateRequest):
    """VCG 경매 — 가중치 기반 배분 + VCG 가격 계산"""
    if not req.bids:
        raise HTTPException(400, "입찰이 비어있습니다")
    if req.total_seats <= 0:
        raise HTTPException(400, "좌석 수는 1 이상이어야 합니다")

    bids = [
        BidInput(
            bid_id=b.bid_id,
            user_id=b.user_id,
            max_willingness_to_pay=b.max_willingness_to_pay,
            effective_weight=b.effective_weight,
            quantity=b.quantity,
        )
        for b in req.bids
    ]
    inp = AllocationInput(
        bids=bids,
        total_seats=req.total_seats,
        min_price=req.min_price,
        max_price_cap=req.max_price_cap,
        stabilization_lambda=req.stabilization_lambda,
    )
    result = vcg_engine.allocate(inp)

    return {
        "winners": [
            {
                "bid_id": w.bid_id,
                "user_id": w.user_id,
                "bid_amount": w.bid_amount,
                "effective_weight": w.effective_weight,
                "weighted_value": w.weighted_value,
                "vcg_price": w.vcg_price,
                "final_price": w.final_price,
                "resale_risk_score": w.resale_risk_score,
            }
            for w in result.winners
        ],
        "total_revenue": result.total_revenue,
        "total_allocated": len(result.winners),
    }

# ─── 팬 가중치 ───

class FanWeightRequest(BaseModel):
    loyalty: float = 0.0
    history: float = 0.0
    fanclub: float = 0.0
    behavior: float = 1.0
    freshness: float = 0.0

@app.post("/fan-weight")
def calculate_fan_weight(req: FanWeightRequest):
    """팬 가중치 계산 — 5차원 점수 → effective_weight"""
    scores = FanScores(
        loyalty=req.loyalty,
        history=req.history,
        fanclub=req.fanclub,
        behavior=req.behavior,
        freshness=req.freshness,
    )
    weight = compute_fan_weight_v2(scores)
    return {
        "effective_weight": weight,
        "scores": {
            "loyalty": scores.loyalty,
            "history": scores.history,
            "fanclub": scores.fanclub,
            "behavior": scores.behavior,
            "freshness": scores.freshness,
        },
    }

# ─── 추첨 ───

class LotteryEntryRequest(BaseModel):
    user_id: str
    group_id: str | None = None
    group_size: int = 1

class LotteryRequest(BaseModel):
    tier_id: str = "default"
    entries: list[LotteryEntryRequest]
    total_seats: int
    use_fan_weight: bool = True
    weights: dict[str, float] | None = None
    seed: int | None = None
    # Commit-reveal v2: per-user client seeds for verifiable, tamper-evident
    # draws — same verification format the platform engine produces.
    client_seeds: dict[str, str] | None = None

@app.post("/lottery")
def lottery(req: LotteryRequest):
    """가중치 추첨 — platform/engine 정본과 동일한 가산 가중치(BASE_WEIGHT+AP보너스)
    및 commit-reveal v2 검증 데이터를 생성한다. (구버전 곱셈 가중·검증 데이터
    부재 엔진은 정본 동기화로 제거됨 — 감사 idx9)"""
    if not req.entries:
        raise HTTPException(400, "참가자가 비어있습니다")
    if req.total_seats <= 0:
        raise HTTPException(400, "좌석 수는 1 이상이어야 합니다")

    pool = LotteryPool(
        tier_id=req.tier_id,
        total_seats=req.total_seats,
        use_fan_weight=req.use_fan_weight,
    )
    for e in req.entries:
        pool.entries.append(
            LotteryEntry(user_id=e.user_id, group_id=e.group_id, group_size=e.group_size)
        )

    result = run_lottery(
        pool,
        weights=req.weights,
        seed=req.seed,
        client_seeds=req.client_seeds,
    )
    return {
        "winners": result.winners,
        "waitlist": result.waitlist,
        "total_applicants": result.total_applicants,
        "total_seats": result.total_seats,
        "seed_used": result.seed_used,
        "commitment_hash": result.commitment_hash,
        # Commit-reveal v2 검증 데이터 — platform 과 동일 포맷으로 노출하여
        # 어느 경로로 추첨했든 독립 검증이 가능하게 한다.
        "server_seed": result.server_seed,
        "client_seeds_hash": result.client_seeds_hash,
        "entries_digest": result.entries_digest,
        "verification_data": result.verification_data,
    }
