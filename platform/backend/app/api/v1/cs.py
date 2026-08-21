"""CS 티켓 관리 API — 관리자 전용 고객 지원 엔드포인트."""

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_admin
from app.models.cs_ticket import CSTicket, CSTicketComment, TicketStatus, TicketPriority
from app.models.user import User
from app.models.event import Event
from app.schemas.cs import (
    CSTicketCreate,
    CSTicketUpdate,
    CSTicketCommentCreate,
    CSTicketResponse,
    CSTicketListResponse,
    CSTicketDetailResponse,
    CSTicketCommentResponse,
    CSTicketStatsResponse,
)

router = APIRouter()
logger = logging.getLogger(__name__)

# SLA 시간 매핑 (priority → hours)
SLA_HOURS: dict[str, int] = {
    TicketPriority.URGENT.value: 1,
    TicketPriority.HIGH.value: 4,
    TicketPriority.NORMAL.value: 24,
    TicketPriority.LOW.value: 72,
}


def _compute_sla_deadline(priority: str, base_time: datetime | None = None) -> datetime:
    """우선순위 기반 SLA 마감시간 계산."""
    base = base_time or datetime.now(timezone.utc)
    hours = SLA_HOURS.get(priority, 24)
    return base + timedelta(hours=hours)


async def _enrich_ticket(ticket: CSTicket, db: AsyncSession) -> dict:
    """티켓에 reporter/assignee/event 이름 정보 추가."""
    data = {
        "id": ticket.id,
        "subject": ticket.subject,
        "description": ticket.description,
        "category": ticket.category,
        "status": ticket.status,
        "priority": ticket.priority,
        "reporter_id": ticket.reporter_id,
        "assignee_id": ticket.assignee_id,
        "event_id": ticket.event_id,
        "related_order_id": ticket.related_order_id,
        "sla_deadline": ticket.sla_deadline,
        "escalated": ticket.escalated,
        "created_at": ticket.created_at,
        "updated_at": ticket.updated_at,
        "resolved_at": ticket.resolved_at,
    }

    # Reporter info
    reporter = await db.get(User, ticket.reporter_id)
    if reporter:
        data["reporter_name"] = reporter.name
        data["reporter_email"] = reporter.email

    # Assignee info
    if ticket.assignee_id:
        assignee = await db.get(User, ticket.assignee_id)
        if assignee:
            data["assignee_name"] = assignee.name
            data["assignee_email"] = assignee.email

    # Event info
    if ticket.event_id:
        event = await db.get(Event, ticket.event_id)
        if event:
            data["event_title"] = event.title

    # Comment count
    count_q = select(func.count()).select_from(CSTicketComment).where(
        CSTicketComment.ticket_id == ticket.id
    )
    result = await db.execute(count_q)
    data["comment_count"] = result.scalar() or 0

    return data


# ─── GET /admin/cs/tickets — 티켓 목록 ─────────────────────────────────────

@router.get("/admin/cs/tickets", response_model=CSTicketListResponse)
async def list_cs_tickets(
    status: str | None = Query(None),
    priority: str | None = Query(None),
    category: str | None = Query(None),
    assignee_id: str | None = Query(None),
    escalated: bool | None = Query(None),
    q: str | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """CS 티켓 목록 조회 (필터링/페이징)."""
    query = select(CSTicket)

    if status:
        query = query.where(CSTicket.status == status)
    if priority:
        query = query.where(CSTicket.priority == priority)
    if category:
        query = query.where(CSTicket.category == category)
    if assignee_id:
        query = query.where(CSTicket.assignee_id == uuid.UUID(assignee_id))
    if escalated is not None:
        query = query.where(CSTicket.escalated == escalated)
    if q:
        search = f"%{q}%"
        query = query.where(
            or_(
                CSTicket.subject.ilike(search),
                CSTicket.description.ilike(search),
            )
        )

    # Total count
    count_q = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_q)
    total = total_result.scalar() or 0

    # Fetch tickets
    query = query.order_by(CSTicket.created_at.desc()).offset(skip).limit(limit)
    result = await db.execute(query)
    tickets = list(result.scalars().all())

    enriched = [await _enrich_ticket(t, db) for t in tickets]

    return CSTicketListResponse(
        tickets=[CSTicketResponse(**d) for d in enriched],
        total=total,
    )


# ─── POST /admin/cs/tickets — 티켓 생성 ────────────────────────────────────

@router.post("/admin/cs/tickets", response_model=CSTicketResponse, status_code=201)
async def create_cs_ticket(
    body: CSTicketCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """관리자가 사용자 대신 CS 티켓 생성."""
    # Validate reporter exists
    reporter = await db.get(User, body.reporter_id)
    if not reporter:
        raise HTTPException(status_code=404, detail="신고자 사용자를 찾을 수 없습니다.")

    now = datetime.now(timezone.utc)
    ticket = CSTicket(
        subject=body.subject,
        description=body.description,
        category=body.category,
        priority=body.priority,
        reporter_id=body.reporter_id,
        assignee_id=body.assignee_id,
        event_id=body.event_id,
        related_order_id=body.related_order_id,
        sla_deadline=_compute_sla_deadline(body.priority, now),
        created_at=now,
        updated_at=now,
    )
    db.add(ticket)
    await db.commit()
    await db.refresh(ticket)

    enriched = await _enrich_ticket(ticket, db)
    return CSTicketResponse(**enriched)


# ─── GET /admin/cs/tickets/{id} — 티켓 상세 ────────────────────────────────

@router.get("/admin/cs/tickets/{ticket_id}", response_model=CSTicketDetailResponse)
async def get_cs_ticket(
    ticket_id: uuid.UUID,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """CS 티켓 상세 조회 (댓글 포함)."""
    result = await db.execute(
        select(CSTicket)
        .options(selectinload(CSTicket.comments))
        .where(CSTicket.id == ticket_id)
    )
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="티켓을 찾을 수 없습니다.")

    enriched = await _enrich_ticket(ticket, db)

    # Enrich comments with author info
    comments = []
    for c in ticket.comments:
        author = await db.get(User, c.author_id)
        comments.append(CSTicketCommentResponse(
            id=c.id,
            ticket_id=c.ticket_id,
            author_id=c.author_id,
            author_name=author.name if author else None,
            author_email=author.email if author else None,
            content=c.content,
            is_internal=c.is_internal,
            created_at=c.created_at,
        ))

    return CSTicketDetailResponse(**enriched, comments=comments)


# ─── PATCH /admin/cs/tickets/{id} — 티켓 수정 ──────────────────────────────

@router.patch("/admin/cs/tickets/{ticket_id}", response_model=CSTicketResponse)
async def update_cs_ticket(
    ticket_id: uuid.UUID,
    body: CSTicketUpdate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """CS 티켓 상태/담당자/우선순위 변경."""
    ticket = await db.get(CSTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="티켓을 찾을 수 없습니다.")

    now = datetime.now(timezone.utc)

    if body.subject is not None:
        ticket.subject = body.subject
    if body.description is not None:
        ticket.description = body.description
    if body.category is not None:
        ticket.category = body.category
    if body.assignee_id is not None:
        ticket.assignee_id = body.assignee_id

    # Priority 변경 시 SLA 재계산
    if body.priority is not None and body.priority != ticket.priority:
        ticket.priority = body.priority
        ticket.sla_deadline = _compute_sla_deadline(body.priority, now)

    # Status 변경
    if body.status is not None and body.status != ticket.status:
        ticket.status = body.status
        if body.status in (TicketStatus.RESOLVED.value, TicketStatus.CLOSED.value):
            ticket.resolved_at = now

    ticket.updated_at = now
    await db.commit()
    await db.refresh(ticket)

    enriched = await _enrich_ticket(ticket, db)
    return CSTicketResponse(**enriched)


# ─── POST /admin/cs/tickets/{id}/comments — 댓글 추가 ──────────────────────

@router.post(
    "/admin/cs/tickets/{ticket_id}/comments",
    response_model=CSTicketCommentResponse,
    status_code=201,
)
async def add_cs_ticket_comment(
    ticket_id: uuid.UUID,
    body: CSTicketCommentCreate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """CS 티켓에 댓글 추가 (내부 메모 또는 고객 응답)."""
    ticket = await db.get(CSTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="티켓을 찾을 수 없습니다.")

    comment = CSTicketComment(
        ticket_id=ticket_id,
        author_id=admin.id,
        content=body.content,
        is_internal=body.is_internal,
    )
    db.add(comment)

    # 댓글 추가 시 updated_at 갱신
    ticket.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(comment)

    return CSTicketCommentResponse(
        id=comment.id,
        ticket_id=comment.ticket_id,
        author_id=comment.author_id,
        author_name=admin.name,
        author_email=admin.email,
        content=comment.content,
        is_internal=comment.is_internal,
        created_at=comment.created_at,
    )


# ─── GET /admin/cs/tickets/{id}/comments — 댓글 목록 ───────────────────────

@router.get(
    "/admin/cs/tickets/{ticket_id}/comments",
    response_model=list[CSTicketCommentResponse],
)
async def list_cs_ticket_comments(
    ticket_id: uuid.UUID,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """CS 티켓 댓글 목록 조회."""
    ticket = await db.get(CSTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="티켓을 찾을 수 없습니다.")

    result = await db.execute(
        select(CSTicketComment)
        .where(CSTicketComment.ticket_id == ticket_id)
        .order_by(CSTicketComment.created_at.asc())
    )
    comments = list(result.scalars().all())

    enriched = []
    for c in comments:
        author = await db.get(User, c.author_id)
        enriched.append(CSTicketCommentResponse(
            id=c.id,
            ticket_id=c.ticket_id,
            author_id=c.author_id,
            author_name=author.name if author else None,
            author_email=author.email if author else None,
            content=c.content,
            is_internal=c.is_internal,
            created_at=c.created_at,
        ))

    return enriched


# ─── POST /admin/cs/tickets/{id}/escalate — 에스컬레이션 ───────────────────

@router.post("/admin/cs/tickets/{ticket_id}/escalate", response_model=CSTicketResponse)
async def escalate_cs_ticket(
    ticket_id: uuid.UUID,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """CS 티켓 에스컬레이션 — 우선순위 URGENT로 상향, SLA 1시간 재설정."""
    ticket = await db.get(CSTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="티켓을 찾을 수 없습니다.")

    if ticket.escalated:
        raise HTTPException(status_code=400, detail="이미 에스컬레이션된 티켓입니다.")

    now = datetime.now(timezone.utc)
    ticket.escalated = True
    ticket.priority = TicketPriority.URGENT.value
    ticket.sla_deadline = _compute_sla_deadline(TicketPriority.URGENT.value, now)
    ticket.updated_at = now

    # 에스컬레이션 내부 댓글 자동 추가
    auto_comment = CSTicketComment(
        ticket_id=ticket_id,
        author_id=admin.id,
        content=f"[시스템] {admin.name}님이 에스컬레이션 처리했습니다. 우선순위가 URGENT로 변경되었습니다.",
        is_internal=True,
    )
    db.add(auto_comment)

    await db.commit()
    await db.refresh(ticket)

    enriched = await _enrich_ticket(ticket, db)
    return CSTicketResponse(**enriched)


# ─── GET /admin/cs/stats — 통계 ────────────────────────────────────────────

@router.get("/admin/cs/stats", response_model=CSTicketStatsResponse)
async def get_cs_stats(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """CS 티켓 현황 통계."""
    now = datetime.now(timezone.utc)

    total_q = select(func.count()).select_from(CSTicket)
    total = (await db.execute(total_q)).scalar() or 0

    async def _count_status(s: str) -> int:
        q = select(func.count()).select_from(CSTicket).where(CSTicket.status == s)
        return (await db.execute(q)).scalar() or 0

    open_count = await _count_status(TicketStatus.OPEN.value)
    in_progress = await _count_status(TicketStatus.IN_PROGRESS.value)
    waiting = await _count_status(TicketStatus.WAITING_CUSTOMER.value)
    resolved = await _count_status(TicketStatus.RESOLVED.value)
    closed = await _count_status(TicketStatus.CLOSED.value)

    # Overdue: SLA 마감시간이 지난 미해결 티켓
    overdue_q = (
        select(func.count())
        .select_from(CSTicket)
        .where(
            CSTicket.sla_deadline < now,
            CSTicket.status.in_([
                TicketStatus.OPEN.value,
                TicketStatus.IN_PROGRESS.value,
                TicketStatus.WAITING_CUSTOMER.value,
            ]),
        )
    )
    overdue = (await db.execute(overdue_q)).scalar() or 0

    return CSTicketStatsResponse(
        total=total,
        open=open_count,
        in_progress=in_progress,
        waiting_customer=waiting,
        resolved=resolved,
        closed=closed,
        overdue=overdue,
    )
