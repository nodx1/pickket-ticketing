import uuid
from datetime import datetime
from pydantic import BaseModel, Field


class LotteryApply(BaseModel):
    group_id: uuid.UUID | None = None
    group_size: int = Field(default=1, ge=1, le=4)
    client_seed: str | None = Field(default=None, max_length=64)
    invested_ap: int = Field(default=0, ge=0, le=10000)  # WP12: 0=미투자 참여


class LotteryEntryResponse(BaseModel):
    id: uuid.UUID
    pool_id: uuid.UUID
    user_id: uuid.UUID
    group_size: int
    fan_weight: float
    invested_ap: int = 0
    tier_multiplier: float = 1.0
    pity_bonus: float = 1.0
    amendment_count: int = 0
    result: str
    created_at: datetime

    model_config = {"from_attributes": True}


class LotteryPoolResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    tier_id: uuid.UUID
    total_seats: int
    total_applicants: int = 0
    status: str
    seed_used: int | None = None
    # Commit-reveal v2: 추첨 전에 공개되는 사전 시드 커밋.
    # (server_seed 는 DRAWN 후 verify 응답에서만 reveal — 여기 포함 금지)
    seed_commitment: str | None = None
    committed_at: datetime | None = None

    model_config = {"from_attributes": True}


class LotteryDrawResult(BaseModel):
    pool_id: uuid.UUID
    winners: int
    waitlisted: int
    seed_used: int


class LotteryVerificationResponse(BaseModel):
    pool_id: uuid.UUID
    commitment_hash: str
    seed_used: int
    algorithm: str
    total_applicants: int
    total_seats: int
    verification_data: dict
    is_valid: bool
    # ── Commit-reveal v2 (후방 호환 추가 필드) ──
    # scheme: commit_reveal_v2 | legacy_post_hoc_commit | vcg_deterministic
    scheme: str = "legacy_post_hoc_commit"
    # legacy 데이터(사후 커밋 시절)는 true — 해시 무결성만 확인 가능하며
    # '시드가 추첨 전에 고정되었다'는 것은 증명되지 않음.
    is_legacy: bool = True
    # 개별 검증 항목: commitment_valid / entries_digest_valid /
    # winners_match / result_hash_valid / commit_precedes_draw ...
    checks: dict = {}
    # 추첨 전에 영속화·공개된 커밋 (H(domain‖pool_id‖server_seed))
    seed_commitment: str | None = None
    # reveal: 추첨 후에만 공개되는 서버 시드
    server_seed: int | None = None
    committed_at: datetime | None = None
    drawn_at: datetime | None = None


class LotteryTransparencyReport(BaseModel):
    pool_id: uuid.UUID
    total_applicants: int
    total_seats: int
    competition_ratio: float
    weight_distribution: dict  # min, max, median, p25, p75
    pool_breakdown: dict  # won/waitlisted/pending counts
    commitment_hash: str
    algorithm: str
    seed_derivation_method: str
    created_at: datetime
    # ── Commit-reveal v2 (후방 호환 추가 필드) ──
    scheme: str = "legacy_post_hoc_commit"
    seed_commitment: str | None = None
    committed_at: datetime | None = None
    drawn_at: datetime | None = None


class LotteryMyResultResponse(BaseModel):
    pool_id: uuid.UUID
    user_id: uuid.UUID
    result: str  # won/waitlisted
    fan_weight: float
    weight_breakdown: dict  # loyalty, history, fanclub, behavior, freshness
    invested_ap: int = 0
    pool_stats: dict  # avg_weight, total_applicants
    verification_link: str
