import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.core.password_policy import validate_password_strength


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    name: str = Field(min_length=1, max_length=100)
    phone: str | None = Field(None, max_length=20)
    is_organizer: bool = False

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        return validate_password_strength(v)


class UserLogin(BaseModel):
    email: EmailStr
    password: str
    captcha_token: str | None = None  # Cloudflare Turnstile (3회 실패 후 필수)


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    phone: str | None
    is_verified: bool
    is_organizer: bool
    is_admin: bool | None = None
    admin_role: str | None = None
    verification_level: int
    loyalty_score: float
    avatar_url: str | None = None
    bio: str | None = None
    preferred_language: str | None = "ko"
    timezone: str | None = "Asia/Seoul"
    created_at: datetime

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str | None = None
    token_type: str = "bearer"
    user: UserResponse
    mfa_required: bool = False  # True면 MFA 코드 입력 필요
    mfa_token: str | None = None  # MFA 검증용 임시 토큰
    captcha_required: bool = False  # True면 다음 로그인 시 CAPTCHA 필요


class UserProfile(BaseModel):
    """Extended user profile with computed fields."""

    id: uuid.UUID
    email: str
    name: str
    phone: str | None
    is_verified: bool
    is_organizer: bool
    is_admin: bool | None = None
    admin_role: str | None = None
    verification_level: int
    loyalty_score: float
    history_score: float
    is_fanclub_member: bool
    no_show_rate: float
    cancel_rate: float
    dispute_rate: float
    fan_weight: float  # computed
    fan_weight_breakdown: dict  # computed breakdown by dimension
    avatar_url: str | None = None
    bio: str | None = None
    preferred_language: str | None = "ko"
    timezone: str | None = "Asia/Seoul"
    created_at: datetime

    model_config = {"from_attributes": True}


class UserUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    phone: str | None = Field(None, max_length=20)
    avatar_url: str | None = Field(None, max_length=500)
    bio: str | None = Field(None, max_length=500)
    preferred_language: str | None = Field(None, max_length=5)
    timezone: str | None = Field(None, max_length=50)


class BidHistoryItem(BaseModel):
    id: uuid.UUID  # bid_id or lottery_entry_id
    bid_id: uuid.UUID | None = None  # deprecated, use id
    event_id: uuid.UUID
    event_title: str
    event_date: datetime
    event_venue: str
    max_willingness_to_pay: float
    quantity: int
    status: str  # BidStatus or LotteryEntryResult
    sale_mode: str | None = None  # e.g. "point_lottery", "fixed_fcfs"
    effective_weight: float | None = None
    final_price: float | None = None  # AllocationResult에서 당첨 시 가져옴
    fair_price: float | None = None
    externality: float | None = None
    invested_ap: int | None = None
    created_at: datetime


class UserStats(BaseModel):
    total_bids: int
    total_wins: int
    total_losses: int
    win_rate: float
    avg_savings: float  # avg(bid_price - final_price) for wins
    total_savings: float


def build_user_response(user) -> UserResponse:
    response = UserResponse.model_validate(user)
    if not getattr(user, "is_admin", False):
        response.is_admin = None
        response.admin_role = None
    return response


class UserPreferenceUpdate(BaseModel):
    """온보딩 취향 upsert (app POST /users/me/preferences)."""
    genres: list[str] | None = None
    artist_ids: list[str] | None = None
    categories: list[str] | None = None


class UserPreferenceResponse(BaseModel):
    genres: list[str] = Field(default_factory=list)
    artist_ids: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)

    model_config = {"from_attributes": True}
