"""go read/write: 조직 팀 멤버 목록·해제·역할변경.

## 왜 신설했나 (2026-07-31)
go 의 팀원 관리 화면이 **go `users` 테이블**을 조회했다. 레벨2 컷오버로 그 원장이
비워지면서(0행) SQL 은 성공하고 **에러 없이 "팀원 0명"** 이 나왔다 —
장애로 보이지 않는 파손이었다(`api/account/members/route.ts` 상단 주석 참조).

v2 에는 `POST /organizer/team` 계열이 이미 있지만 **주최자 JWT 인증**이라
go 의 BFF(서비스 간 호출)에서 쓸 수 없다. 그래서 internal 계열로 같은 원장을 연다.

## 경계
`organizer_ref` 는 `_resolve_organizer` 로 해석한다 — go 세션의 `accountId`(레거시
go_account_id 앵커) 와 v2 user_id 를 **양쪽 다** 받는다. 조직 밖 멤버는 보이지 않는다.

⚠️ **org 레벨만 다룬다**(`event_id IS NULL`). event 레벨 멤버십(host/coordinator/
sponsor)은 go 어휘에 대응이 없고, 세션 해석(`verify-token`)도 org 레벨만 본다.
여기서 event 레벨을 섞으면 화면과 세션이 서로 다른 것을 보게 된다.
"""

import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError,
    OrganizerRef,
    _err,
    _internal_auth,
    _ok,
    _resolve_organizer,
)
from app.core.database import get_db
from app.models.organizer_team import OrganizerTeamMember, TeamRole
from app.models.user import User

router = APIRouter(dependencies=[Depends(_internal_auth)])


def _parse_ref(ref: str) -> OrganizerRef:
    """go accounts.id(문자열) 또는 v2 user uuid → OrganizerRef."""
    try:
        return OrganizerRef(organizer_id=uuid.UUID(ref))
    except (ValueError, AttributeError, TypeError):
        return OrganizerRef(go_account_id=ref)


def _to_go_role(role: TeamRole) -> str:
    """v2 팀 역할 → go 역할. `auth.py:_team_role_to_go_role` 과 **같은 표**여야 한다.

    🔴 두 곳이 갈리면 화면에 보이는 역할과 실제 세션 권한이 달라진다.
    """
    if role == TeamRole.OWNER:
        return "owner"
    if role == TeamRole.MANAGER:
        return "organizer"
    return "staff"


def _from_go_role(role: str) -> TeamRole:
    """go 역할 → v2 팀 역할.

    ⚠️ go 는 5단계(`owner·admin·organizer·staff·check_in`), v2 org 레벨은 3단계다.
       `admin` 이상은 `owner`, `organizer` 는 `manager`, 그 아래는 `viewer` 로 접는다.
       ⟹ `staff` 로 초대하면 v2 `viewer` 가 되고, 세션에선 다시 `staff` 로 돌아온다.
    """
    if role in ("owner", "admin"):
        return TeamRole.OWNER
    if role == "organizer":
        return TeamRole.MANAGER
    return TeamRole.VIEWER


class TeamRoleIn(BaseModel):
    organizer_ref: str = Field(..., max_length=64)
    role: str = Field(..., max_length=32)


class TeamRefIn(BaseModel):
    organizer_ref: str = Field(..., max_length=64)


@router.get("/organizers/{organizer_ref}/team", summary="go read: 팀 멤버 목록")
async def list_team(organizer_ref: str, db: AsyncSession = Depends(get_db)):
    try:
        organizer_id = await _resolve_organizer(db, _parse_ref(organizer_ref))
    except ApiError as e:
        return _err(e)

    rows = (
        await db.execute(
            select(OrganizerTeamMember, User)
            .join(User, User.id == OrganizerTeamMember.user_id)
            .where(
                OrganizerTeamMember.organizer_id == organizer_id,
                OrganizerTeamMember.event_id.is_(None),
                User.deleted_at.is_(None),
            )
            .order_by(OrganizerTeamMember.created_at)
        )
    ).all()

    return _ok(
        {
            "members": [
                {
                    "id": str(tm.id),
                    "userId": str(u.id),
                    "name": u.name,
                    "email": u.email,
                    "role": _to_go_role(tm.role),
                    # 🔴 `isActive` 는 v2 `users.is_active` 다 — verify-token 이 이 값으로
                    #    세션을 끊는다. 화면이 다른 값을 보면 "해제했는데 여전히 접속" 처럼 보인다.
                    "isActive": bool(u.is_active),
                    "lastLoginAt": None,
                    "joinedAt": tm.created_at.isoformat() if tm.created_at else None,
                }
                for tm, u in rows
            ]
        }
    )


@router.delete("/organizers/{organizer_ref}/team/{user_id}", summary="go write: 팀 멤버 해제")
async def remove_team_member(
    organizer_ref: str,
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """멤버십 행을 지운다 — 다음 요청부터 그 사람은 자기 테넌트로 돌아간다.

    🔴 사용자 계정을 지우거나 비활성화하지 **않는다.** 그 사람은 다른 조직의 멤버일 수도
       있고, 소비자로서 티켓을 갖고 있을 수도 있다. 조직에서 빼는 것과 계정을 죽이는 것은
       다른 동작이다(계정 정지가 필요하면 별도 조치).
    """
    try:
        organizer_id = await _resolve_organizer(db, _parse_ref(organizer_ref))
    except ApiError as e:
        return _err(e)

    rows = (
        await db.execute(
            select(OrganizerTeamMember).where(
                OrganizerTeamMember.organizer_id == organizer_id,
                OrganizerTeamMember.user_id == user_id,
                OrganizerTeamMember.event_id.is_(None),
            )
        )
    ).scalars().all()
    if not rows:
        return _ok({"removed": False})

    # 🔴 소유자 자신은 뺄 수 없다 — 조직에 아무도 안 남으면 복구 경로가 없다.
    if user_id == organizer_id:
        return _err(
            ApiError("TEAM_OWNER_NOT_REMOVABLE", "조직 소유자는 팀에서 제외할 수 없습니다", 409, "user_id")
        )

    for row in rows:
        await db.delete(row)
    await db.commit()
    return _ok({"removed": True, "count": len(rows)})


@router.patch("/organizers/{organizer_ref}/team/{user_id}", summary="go write: 팀 멤버 역할 변경")
async def update_team_member(
    organizer_ref: str,
    user_id: uuid.UUID,
    body: TeamRoleIn,
    db: AsyncSession = Depends(get_db),
):
    try:
        organizer_id = await _resolve_organizer(db, _parse_ref(organizer_ref))
    except ApiError as e:
        return _err(e)

    if user_id == organizer_id:
        return _err(
            ApiError("TEAM_OWNER_NOT_EDITABLE", "조직 소유자의 역할은 바꿀 수 없습니다", 409, "user_id")
        )

    rows = (
        await db.execute(
            select(OrganizerTeamMember).where(
                OrganizerTeamMember.organizer_id == organizer_id,
                OrganizerTeamMember.user_id == user_id,
                OrganizerTeamMember.event_id.is_(None),
            )
        )
    ).scalars().all()
    if not rows:
        return _err(ApiError("TEAM_MEMBER_NOT_FOUND", "팀 멤버를 찾을 수 없습니다", 404, "user_id"))

    target = _from_go_role(body.role)
    # 🔴 in-place UPDATE 다. 새 행을 넣으면 role 만 다른 중복이 생기고,
    #    verify-token 의 선택 규칙(owner 우선)이 **강등을 무시**하게 된다.
    for row in rows:
        row.role = target
    # 중복 행이 이미 있으면 하나만 남긴다(과거 upsert 결함의 잔해 정리).
    for extra in rows[1:]:
        await db.delete(extra)
    await db.commit()
    return _ok({"updated": True, "role": _to_go_role(target)})


@router.get("/organizers/{organizer_ref}/team/count", summary="go read: 팀 멤버 수")
async def count_team(
    organizer_ref: str,
    include_owner: bool = Query(True),
    db: AsyncSession = Depends(get_db),
):
    try:
        organizer_id = await _resolve_organizer(db, _parse_ref(organizer_ref))
    except ApiError as e:
        return _err(e)
    stmt = select(OrganizerTeamMember.id).where(
        OrganizerTeamMember.organizer_id == organizer_id,
        OrganizerTeamMember.event_id.is_(None),
    )
    if not include_owner:
        stmt = stmt.where(OrganizerTeamMember.user_id != organizer_id)
    rows = (await db.execute(stmt)).scalars().all()
    return _ok({"count": len(rows)})
