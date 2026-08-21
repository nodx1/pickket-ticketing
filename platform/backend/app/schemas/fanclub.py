import uuid
from datetime import datetime

from pydantic import BaseModel, Field, model_validator


class FanclubCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    artist_name: str | None = Field(None, max_length=200)
    subject_name: str | None = Field(None, max_length=200)
    artist_id: uuid.UUID | None = None
    description: str | None = Field(None, max_length=2000)
    logo_url: str | None = Field(None, max_length=500)
    max_members: int = Field(default=500000, ge=100, le=1000000)
    is_official: bool = False
    community_type: str = "fanclub"
    domain: str | None = None
    custom_tier_labels: str | None = None  # JSON string
    custom_member_label: str | None = None
    event_type_template: str | None = None

    @model_validator(mode="after")
    def sync_names(self):
        """Ensure artist_name and subject_name are cross-populated for backward compatibility."""
        if self.subject_name and not self.artist_name:
            self.artist_name = self.subject_name
        elif self.artist_name and not self.subject_name:
            self.subject_name = self.artist_name
        if not self.artist_name and not self.subject_name:
            raise ValueError("artist_name 또는 subject_name 중 하나는 필수입니다.")
        return self


# Alias for forward-facing code
CommunityCreate = FanclubCreate


class FanclubUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)
    logo_url: str | None = Field(None, max_length=500)
    max_members: int | None = Field(None, ge=100, le=1000000)
    is_official: bool | None = None
    is_active: bool | None = None
    subject_name: str | None = Field(None, max_length=200)
    community_type: str | None = None
    domain: str | None = None
    custom_tier_labels: str | None = None
    custom_member_label: str | None = None
    event_type_template: str | None = None


class FanclubResponse(BaseModel):
    id: uuid.UUID
    name: str
    artist_name: str
    artist_id: uuid.UUID | None
    description: str | None
    logo_url: str | None
    organizer_id: uuid.UUID
    max_members: int
    is_official: bool
    is_active: bool
    member_count: int = 0
    community_type: str = "fanclub"
    subject_name: str | None = None
    domain: str | None = None
    custom_tier_labels: str | None = None
    custom_member_label: str | None = None
    event_type_template: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


# Alias
CommunityResponse = FanclubResponse


class FanclubListResponse(BaseModel):
    fanclubs: list[FanclubResponse]
    total: int


class MembershipJoinRequest(BaseModel):
    membership_code: str = Field(min_length=1, max_length=100)
    tier: str = "basic"


class MembershipResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    user_name: str | None = None
    user_email: str | None = None
    fanclub_id: uuid.UUID
    fanclub_name: str = ""
    artist_name: str = ""
    tier: str
    status: str
    membership_code: str | None = None
    verified_at: datetime | None
    expires_at: datetime | None
    joined_at: datetime

    model_config = {"from_attributes": True}


class MemberListResponse(BaseModel):
    members: list[MembershipResponse]
    total: int
    page: int
    page_size: int


class BulkImportEntry(BaseModel):
    email: str
    membership_code: str = ""
    tier: str = "basic"


class BulkImportRequest(BaseModel):
    entries: list[BulkImportEntry]


class BulkImportResponse(BaseModel):
    total_processed: int
    successful: int
    failed: int
    errors: list[str]
