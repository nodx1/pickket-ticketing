"""Schemas for organizer team management."""

import uuid
from datetime import datetime
from enum import Enum as PyEnum

from pydantic import BaseModel, EmailStr


class TeamRole(str, PyEnum):
    OWNER = "owner"
    MANAGER = "manager"
    VIEWER = "viewer"


class TeamMemberCreate(BaseModel):
    email: EmailStr
    role: TeamRole = TeamRole.VIEWER


class TeamMemberResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    email: str
    role: TeamRole
    joined_at: datetime

    model_config = {"from_attributes": True}


class TeamMemberUpdate(BaseModel):
    role: TeamRole
