"""내부 감사 로그 수집·조회 (레벨2 2차 D4 + 컷오버 스코프A — go audit_logs 완전 흡수).

go 는 lib/audit.ts 로 go DB audit_logs 에 직접 기록·조회했다. go DB 제거를 위해
v2 AuditLog(정본)로 write/read 를 모두 이관한다. 인증: _internal_auth(HMAC + 전환기 토큰).

스키마 매핑(go → v2 AuditLog):
  - go user_id/account_id 는 v2 users FK 가 아닐 수 있으므로(테넌트=go) actor_id=NULL 로 두고
    new_value.go_context 에 원본 식별자(user_id/account_id)를 보존한다 → FK 위반 없이 감사 무손실.
    (actor 매핑 근거: go 사용자는 별도 테넌트 DB 소속. v2 users FK 로 임의 연결하면 잘못된
     주체를 감사기록에 남기게 되어 규제상 더 위험 — NULL + go_context 보존이 정본 설계.)
  - table_name → resource_type, record_id → resource_id, changes → new_value.go_context.changes.
  - actor_type='system'(go 서버 경유) 고정 — CHECK 도메인(user/guest/admin/system) 준수.

규제 요건 충족:
  - 불변(immutability): audit_logs 에 DB 레벨 append-only 트리거
    (trg_audit_logs_no_update/no_delete, 마이그 sa1p1p2sec01)가 UPDATE/DELETE 를 차단.
  - 시계열(time-series): created_at(TIMESTAMPTZ, index) — 서버 기록시각 신뢰.
  - 조회(query): read 엔드포인트가 테넌트(go account_id)·resource_type·record_id·event_id
    필터 + 페이지네이션 지원. **account_id 경계 필수**(크로스테넌트 누출 차단).

멱등: 감사 로그는 append-only. 재시도로 중복 행이 생겨도 무결성 훼손 없음(관측 데이터).
  write 는 커밋 후 응답만 하므로 "동시 2회"·"외부호출 후 crash" 는 append 중복만 발생(무해).
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import distinct, or_
from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from app.api.v1.internal_commerce import _internal_auth
from app.core.database import get_db, get_read_db
from app.models.audit_log import AuditLog

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(_internal_auth)])


class AuditLogIn(BaseModel):
    action: str = Field(..., min_length=1, max_length=100)
    table_name: str = Field(..., min_length=1, max_length=50)
    user_id: str | None = None
    account_id: str | None = None
    record_id: str | None = None
    changes: dict | list | None = None
    ip_address: str | None = None


def _build_go_context(body: AuditLogIn) -> dict:
    """go 감사 원본 식별자 + 변경분을 go_context 로 보존.

    account_id/user_id 는 read 필터(테넌트 경계)의 조회 키가 되므로 항상 최상위에 둔다.
    changes 는 하위 키로 중첩(compliance 조회의 eventId 매칭이 여기를 본다).
    """
    ctx: dict = {
        "source": "go",
        "user_id": body.user_id,
        "account_id": body.account_id,
    }
    if body.changes is not None:
        ctx["changes"] = body.changes
    return ctx


@router.post("/audit-logs")
async def write_go_audit(
    request: Request,
    body: AuditLogIn,
    db: AsyncSession = Depends(get_db),
):
    """go 감사 이벤트 1건 기록 → v2 AuditLog. resource_id 는 문자열(go UUID) 그대로 보존."""
    # outbox 행 id를 키로 전달하면 외부 POST 후 go 워커가 크래시해 재전송해도
    # 동일 AuditLog PK로 흡수한다. 키가 없는 레거시 호출은 기존 UUID append semantics를 유지한다.
    idempotency_key = request.headers.get("idempotency-key")
    entry_id = (
        uuid.uuid5(uuid.NAMESPACE_URL, f"pickket-go-audit:{idempotency_key}")
        if idempotency_key
        else uuid.uuid4()
    )
    if idempotency_key:
        existing = await db.get(AuditLog, entry_id)
        if existing is not None:
            return {"ok": True, "id": str(existing.id), "idempotent_replay": True}
    entry = AuditLog(
        id=entry_id,
        actor_id=None,  # go user_id 는 v2 users FK 가 아님 — go_context 에 보존.
        actor_type="system",
        action=body.action[:100],
        resource_type=body.table_name[:50],
        resource_id=(body.record_id or None),
        new_value=_build_go_context(body),
        ip_address=(body.ip_address or None),
    )
    db.add(entry)
    try:
        await db.commit()
    except IntegrityError:
        # 동시 재전송은 둘 다 pre-check를 통과할 수 있으므로 PK 충돌을 재조회해 흡수한다.
        await db.rollback()
        if idempotency_key:
            existing = await db.get(AuditLog, entry_id)
            if existing is not None:
                return {"ok": True, "id": str(existing.id), "idempotent_replay": True}
        raise
    return {"ok": True, "id": str(entry.id), "idempotent_replay": False}


def _serialize(log: AuditLog) -> dict:
    """v2 AuditLog → go 조회 계약(스네이크). go_context 에서 원본 식별자·changes 복원."""
    ctx = log.new_value if isinstance(log.new_value, dict) else {}
    go_ctx = ctx if ctx.get("source") == "go" else {}
    return {
        "id": str(log.id),
        "account_id": go_ctx.get("account_id"),
        "user_id": go_ctx.get("user_id"),
        "action": log.action,
        "table_name": log.resource_type,
        "record_id": log.resource_id,
        "changes": go_ctx.get("changes"),
        "ip_address": log.ip_address,
        "created_at": log.created_at.isoformat() if log.created_at else None,
    }


@router.get("/audit-logs")
async def read_go_audit(
    account_id: str = Query(..., min_length=1),
    resource_type: str | None = Query(None),
    resource_types: str | None = Query(None, description="쉼표구분 다중 resource_type"),
    record_id: str | None = Query(None),
    event_id: str | None = Query(None, description="go_context.changes.eventId 매칭"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_read_db),
):
    """go 테넌트 감사 로그 조회 (account_id 경계 필수).

    - account_id: go_context.account_id 정확 일치(**크로스테넌트 누출 차단, Critical**).
    - resource_type / resource_types: 단일 또는 다중(쉼표) resource_type 필터.
    - record_id: resource_id 정확 일치.
    - event_id: go_context.changes.eventId 매칭(compliance 이벤트 스코프 조회).
    반환: {"logs": [...], "total": N} — go 는 이를 스네이크→카멜 매핑.
    """
    ctx = AuditLog.new_value
    conds = [ctx["account_id"].astext == account_id]

    types: list[str] = []
    if resource_type:
        types.append(resource_type)
    if resource_types:
        types.extend(t.strip() for t in resource_types.split(",") if t.strip())
    if len(types) == 1:
        conds.append(AuditLog.resource_type == types[0])
    elif len(types) > 1:
        conds.append(AuditLog.resource_type.in_(types))

    if record_id:
        conds.append(AuditLog.resource_id == record_id)
    if event_id:
        # go_context.changes.eventId 매칭. changes 는 dict 일 때만 ->> 가 값 반환.
        conds.append(ctx["changes"]["eventId"].astext == event_id)

    base = select(AuditLog).where(*conds)
    total = (await db.execute(
        select(sa_func.count()).select_from(base.subquery())
    )).scalar() or 0

    result = await db.execute(
        base.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit)
    )
    logs = result.scalars().all()
    return {"logs": [_serialize(log) for log in logs], "total": total}


# 이벤트 감사 추적(compliance)에서 이벤트 스코프로 취급하는 go 테이블.
_COMPLIANCE_EVENT_TABLES = [
    "events", "products", "orders", "order_items",
    "attendees", "check_ins", "campaigns", "promo_codes",
]


@router.get("/audit-logs/compliance")
async def read_compliance_audit(
    account_id: str = Query(..., min_length=1),
    event_id: str = Query(..., min_length=1),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_read_db),
):
    """이벤트 감사 추적 조회 + 통계 (account_id 경계 필수).

    go compliance 라우트의 OR 술어를 v2 정본 스키마로 재현:
      (resource_type='events' AND resource_id=event_id)
      OR (resource_type IN 이벤트테이블 AND go_context.changes.eventId=event_id)
    통계(totalLogs/uniqueUsers/tablesAffected/deleteActions)는 동일 술어 위에서 집계.
      - uniqueUsers 는 go_context.user_id(actor_id 가 NULL 이므로) 기준 distinct.
      - refundCount/totalOrderCount 는 go orders 프로젝션 소관이라 감사조회에서 제외
        (compliance 화면 미사용 필드 — 이관과 함께 정리).
    """
    ctx = AuditLog.new_value
    tenant = ctx["account_id"].astext == account_id
    scope = or_(
        (AuditLog.resource_type == "events") & (AuditLog.resource_id == event_id),
        AuditLog.resource_type.in_(_COMPLIANCE_EVENT_TABLES)
        & (ctx["changes"]["eventId"].astext == event_id),
    )
    where = (tenant, scope)

    base = select(AuditLog).where(*where)

    stats_row = (await db.execute(
        select(
            sa_func.count(AuditLog.id),
            sa_func.count(distinct(ctx["user_id"].astext)),
            sa_func.count(distinct(AuditLog.resource_type)),
            sa_func.count(AuditLog.id).filter(AuditLog.action == "delete"),
        ).where(*where)
    )).one()

    result = await db.execute(
        base.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit)
    )
    logs = result.scalars().all()

    return {
        "logs": [
            {
                "id": str(log.id),
                "action": log.action,
                "tableName": log.resource_type,
                "recordId": log.resource_id,
                "changes": (log.new_value or {}).get("changes")
                if isinstance(log.new_value, dict) else None,
                "ipAddress": log.ip_address,
                "createdAt": log.created_at.isoformat() if log.created_at else None,
                # go user 는 v2 users FK 가 아님 → 이름/이메일 조회 불가.
                # go_context.user_id 만 노출(UI 는 없으면 '-' 표시).
                "userName": None,
                "userEmail": None,
                "userId": (log.new_value or {}).get("user_id")
                if isinstance(log.new_value, dict) else None,
            }
            for log in logs
        ],
        "stats": {
            "totalLogs": stats_row[0] or 0,
            "uniqueUsers": stats_row[1] or 0,
            "tablesAffected": stats_row[2] or 0,
            "deleteActions": stats_row[3] or 0,
        },
    }
