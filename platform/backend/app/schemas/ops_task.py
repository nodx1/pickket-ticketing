"""운영 작업보드 스키마 — admin UI 와 AI 에이전트(서비스토큰) 공용."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

OpsStatus = Literal["backlog", "in_progress", "review", "blocked", "done"]
OpsLabel = Literal["frontend", "backend", "security", "cs", "sales", "ops", "bug", "feature"]
OpsPriority = Literal["critical", "high", "medium", "low"]


class OpsTaskCreate(BaseModel):
    title: str = Field(min_length=2, max_length=300)
    body: str | None = None
    status: OpsStatus = "backlog"
    label: OpsLabel = "ops"
    priority: OpsPriority = "medium"
    assignee: str | None = Field(default=None, max_length=100)  # "user:이름" | "agent:이름"
    created_by: str = Field(max_length=100)
    source: str = Field(default="manual", max_length=50)
    links: dict | None = None
    due_at: datetime | None = None


class OpsTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=300)
    body: str | None = None
    status: OpsStatus | None = None
    label: OpsLabel | None = None
    priority: OpsPriority | None = None
    assignee: str | None = Field(default=None, max_length=100)
    links: dict | None = None
    due_at: datetime | None = None


class OpsTaskItem(BaseModel):
    id: uuid.UUID
    title: str
    body: str | None
    status: str
    label: str
    priority: str
    assignee: str | None
    created_by: str
    source: str
    links: dict | None
    due_at: datetime | None
    created_at: datetime
    updated_at: datetime
    comment_count: int = 0

    model_config = {"from_attributes": True}


class OpsCommentCreate(BaseModel):
    author: str = Field(max_length=100)
    body: str = Field(min_length=1)


class OpsCommentItem(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    author: str
    body: str
    created_at: datetime

    model_config = {"from_attributes": True}
