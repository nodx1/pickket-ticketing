"""운영 작업보드 API — 사람(admin 인증)과 AI 에이전트(서비스토큰)가 같은 보드를 쓴다.

경로 2계열(핸들러 공유):
  /admin/ops/tasks*     — get_current_admin (admin UI 용)
  /internal/ops/tasks*  — X-Pickket-Service-Token (관제/에이전트 용, 읽기+쓰기)
설계: docs/OPS_ORCHESTRATION_PLAN.md §3. created_by/assignee 는 "user:*"|"agent:*" 로 감사 추적.
"""

import hmac
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.middleware.auth import get_current_admin
from app.models.ops_task import OpsTask, OpsTaskComment
from app.models.user import User
from app.schemas.ops_task import (
    OpsCommentCreate,
    OpsCommentItem,
    OpsTaskCreate,
    OpsTaskItem,
    OpsTaskUpdate,
)

admin_router = APIRouter()
internal_router = APIRouter()


def _require_service_token(request: Request) -> None:
    """에이전트 경로 인증 — internal_sync 와 동일한 timing-safe 서비스토큰 검증."""
    token = request.headers.get("x-pickket-service-token", "")
    secret = settings.internal_service_token
    if not token or not secret or not hmac.compare_digest(token, secret):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service token")


# ── 공유 핸들러 ──────────────────────────────────────────────


async def _list_tasks(
    db: AsyncSession,
    status_f: str | None,
    label: str | None,
    assignee: str | None,
    limit: int,
) -> list[OpsTaskItem]:
    comment_count = (
        select(func.count(OpsTaskComment.id)).where(OpsTaskComment.task_id == OpsTask.id)
    ).scalar_subquery()
    q = select(OpsTask, comment_count.label("comment_count"))
    if status_f:
        q = q.where(OpsTask.status == status_f)
    if label:
        q = q.where(OpsTask.label == label)
    if assignee:
        q = q.where(OpsTask.assignee == assignee)
    q = q.order_by(OpsTask.priority.asc(), OpsTask.updated_at.desc()).limit(limit)
    rows = (await db.execute(q)).all()
    items = []
    for task, cnt in rows:
        item = OpsTaskItem.model_validate(task)
        item.comment_count = int(cnt or 0)
        items.append(item)
    return items


async def _get_task(db: AsyncSession, task_id: uuid.UUID) -> OpsTask:
    task = (await db.execute(select(OpsTask).where(OpsTask.id == task_id))).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="작업을 찾을 수 없습니다")
    return task


async def _create_task(db: AsyncSession, body: OpsTaskCreate) -> OpsTaskItem:
    task = OpsTask(**body.model_dump())
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return OpsTaskItem.model_validate(task)


async def _update_task(db: AsyncSession, task_id: uuid.UUID, body: OpsTaskUpdate) -> OpsTaskItem:
    task = await _get_task(db, task_id)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(task, k, v)
    await db.commit()
    await db.refresh(task)
    return OpsTaskItem.model_validate(task)


async def _list_comments(db: AsyncSession, task_id: uuid.UUID) -> list[OpsCommentItem]:
    await _get_task(db, task_id)
    rows = (
        await db.execute(
            select(OpsTaskComment)
            .where(OpsTaskComment.task_id == task_id)
            .order_by(OpsTaskComment.created_at.asc())
        )
    ).scalars()
    return [OpsCommentItem.model_validate(c) for c in rows]


async def _add_comment(db: AsyncSession, task_id: uuid.UUID, body: OpsCommentCreate) -> OpsCommentItem:
    await _get_task(db, task_id)
    comment = OpsTaskComment(task_id=task_id, author=body.author, body=body.body)
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return OpsCommentItem.model_validate(comment)


# ── admin 경로 (사람 — admin UI) ─────────────────────────────


@admin_router.get("/ops/tasks", response_model=list[OpsTaskItem])
async def admin_list_tasks(
    status_f: str | None = Query(default=None, alias="status"),
    label: str | None = None,
    assignee: str | None = None,
    limit: int = Query(default=200, le=500),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    return await _list_tasks(db, status_f, label, assignee, limit)


@admin_router.post("/ops/tasks", response_model=OpsTaskItem, status_code=201)
async def admin_create_task(
    body: OpsTaskCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    # 사람 생성은 created_by 를 로그인 사용자로 강제(위장 방지).
    body.created_by = f"user:{admin.name or admin.email}"
    return await _create_task(db, body)


@admin_router.patch("/ops/tasks/{task_id}", response_model=OpsTaskItem)
async def admin_update_task(
    task_id: uuid.UUID,
    body: OpsTaskUpdate,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    return await _update_task(db, task_id, body)


@admin_router.get("/ops/tasks/{task_id}/comments", response_model=list[OpsCommentItem])
async def admin_list_comments(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    return await _list_comments(db, task_id)


@admin_router.post("/ops/tasks/{task_id}/comments", response_model=OpsCommentItem, status_code=201)
async def admin_add_comment(
    task_id: uuid.UUID,
    body: OpsCommentCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    body.author = f"user:{admin.name or admin.email}"
    return await _add_comment(db, task_id, body)


# ── internal 경로 (AI 에이전트 — 서비스토큰) ──────────────────


@internal_router.get("/internal/ops/tasks", response_model=list[OpsTaskItem])
async def internal_list_tasks(
    request: Request,
    status_f: str | None = Query(default=None, alias="status"),
    label: str | None = None,
    assignee: str | None = None,
    limit: int = Query(default=200, le=500),
    db: AsyncSession = Depends(get_db),
):
    _require_service_token(request)
    return await _list_tasks(db, status_f, label, assignee, limit)


@internal_router.post("/internal/ops/tasks", response_model=OpsTaskItem, status_code=201)
async def internal_create_task(
    request: Request, body: OpsTaskCreate, db: AsyncSession = Depends(get_db)
):
    _require_service_token(request)
    if not body.created_by.startswith(("agent:", "cron:")):
        raise HTTPException(status_code=422, detail="created_by 는 agent:* 또는 cron:* 이어야 합니다")
    return await _create_task(db, body)


@internal_router.patch("/internal/ops/tasks/{task_id}", response_model=OpsTaskItem)
async def internal_update_task(
    request: Request, task_id: uuid.UUID, body: OpsTaskUpdate, db: AsyncSession = Depends(get_db)
):
    _require_service_token(request)
    return await _update_task(db, task_id, body)


@internal_router.post(
    "/internal/ops/tasks/{task_id}/comments", response_model=OpsCommentItem, status_code=201
)
async def internal_add_comment(
    request: Request, task_id: uuid.UUID, body: OpsCommentCreate, db: AsyncSession = Depends(get_db)
):
    _require_service_token(request)
    if not body.author.startswith(("agent:", "cron:")):
        raise HTTPException(status_code=422, detail="author 는 agent:* 또는 cron:* 이어야 합니다")
    return await _add_comment(db, task_id, body)
