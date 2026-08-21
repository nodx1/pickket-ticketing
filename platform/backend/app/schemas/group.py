import uuid
from datetime import datetime

from pydantic import BaseModel


class GroupCreateRequest(BaseModel):
    event_id: uuid.UUID
    tier_id: uuid.UUID
    require_adjacent: bool = True


class GroupMemberResponse(BaseModel):
    user_id: uuid.UUID
    user_name: str = ""
    status: str = "joined"
    joined_at: datetime | None = None

    model_config = {"from_attributes": True}


class GroupResponse(BaseModel):
    id: uuid.UUID
    group_code: str
    leader_user_id: uuid.UUID
    event_id: uuid.UUID
    tier_id: uuid.UUID
    require_adjacent: bool
    members: list[GroupMemberResponse] = []
    max_size: int = 4

    model_config = {"from_attributes": True}


class GroupListResponse(BaseModel):
    groups: list[GroupResponse]
