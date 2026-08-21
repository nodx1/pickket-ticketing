"""P2-15: Admin RBAC granular management API.

커스텀 역할 CRUD + 사용자 역할 할당.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.core.database import get_db, get_read_db
from app.core.rbac import ROLE_SCOPES
from app.core.redis import cache_get_json, cache_set_json, cache_delete, invalidate_user_cache
from app.middleware.auth import get_current_admin, require_scope
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()

# ── All available scopes (grouped by category) ──────────────────────────

SCOPE_CATEGORIES: dict[str, list[str]] = {
    "events": [
        "events.manage",
        "events.view",
        "events.approve",
        "events.feature",
    ],
    "users": [
        "users.manage",
        "users.view",
        "users.ban",
    ],
    "finance": [
        "finance.view",
        "finance.manage",
        "orders.manage",
        "refunds.request",
        "refunds.approve",
        "settlements.review",
        "settlements.approve",
    ],
    "cs": [
        "notifications.send",
        "communities.manage",
    ],
    "system": [
        "audit.view",
        "organizers.manage",
        "system.settings",
    ],
}

ALL_SCOPES = [scope for scopes in SCOPE_CATEGORIES.values() for scope in scopes]

_CUSTOM_ROLES_KEY = "admin:custom_roles"


# ── Schemas ──────────────────────────────────────────────────────────────


class ScopeCategory(BaseModel):
    category: str
    scopes: list[str]


class RoleItem(BaseModel):
    name: str
    scopes: list[str]
    is_builtin: bool
    user_count: int = 0


class RoleListResponse(BaseModel):
    roles: list[RoleItem]
    scope_categories: list[ScopeCategory]


class CreateRoleRequest(BaseModel):
    name: str
    scopes: list[str]


class UpdateRoleRequest(BaseModel):
    scopes: list[str]


class AssignRoleRequest(BaseModel):
    role: str


class RoleResponse(BaseModel):
    name: str
    scopes: list[str]
    is_builtin: bool


class AdminUserRoleItem(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    admin_role: str | None
    is_admin: bool


# ── Helpers ──────────────────────────────────────────────────────────────


async def _get_custom_roles() -> dict[str, list[str]]:
    """Redis에서 커스텀 역할 목록 조회."""
    data = await cache_get_json(_CUSTOM_ROLES_KEY)
    if data and isinstance(data, dict):
        return data
    return {}


async def _save_custom_roles(roles: dict[str, list[str]]) -> None:
    """Redis에 커스텀 역할 목록 저장 (TTL 없음 = 7일)."""
    await cache_set_json(_CUSTOM_ROLES_KEY, roles, ttl=604800)


def _get_all_roles(custom_roles: dict[str, list[str]]) -> dict[str, set[str] | list[str]]:
    """내장 + 커스텀 역할 통합."""
    all_roles: dict[str, set[str] | list[str]] = dict(ROLE_SCOPES)
    for name, scopes in custom_roles.items():
        all_roles[name] = scopes
    return all_roles


# ── Endpoints ────────────────────────────────────────────────────────────


@router.get("/admin/roles", response_model=RoleListResponse)
async def list_roles(
    admin: User = Depends(require_scope("audit.view")),
    read_db: AsyncSession = Depends(get_read_db),
):
    """모든 역할 목록 + 스코프 카테고리 조회."""
    custom_roles = await _get_custom_roles()

    # 사용자 수 카운트
    result = await read_db.execute(
        select(User.admin_role, User.id).where(User.is_admin.is_(True))
    )
    admin_users = result.all()
    role_counts: dict[str, int] = {}
    for row in admin_users:
        role = row[0] or "viewer"
        role_counts[role] = role_counts.get(role, 0) + 1

    roles: list[RoleItem] = []

    # 내장 역할
    for name, scopes in ROLE_SCOPES.items():
        roles.append(
            RoleItem(
                name=name,
                scopes=sorted(scopes),
                is_builtin=True,
                user_count=role_counts.get(name, 0),
            )
        )

    # 커스텀 역할
    for name, scopes in custom_roles.items():
        roles.append(
            RoleItem(
                name=name,
                scopes=sorted(scopes),
                is_builtin=False,
                user_count=role_counts.get(name, 0),
            )
        )

    scope_categories = [
        ScopeCategory(category=cat, scopes=scopes)
        for cat, scopes in SCOPE_CATEGORIES.items()
    ]

    return RoleListResponse(roles=roles, scope_categories=scope_categories)


@router.post("/admin/roles", response_model=RoleResponse, status_code=201)
async def create_role(
    body: CreateRoleRequest,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    """커스텀 역할 생성."""
    # 이름 검증
    if not body.name or len(body.name) < 2:
        raise HTTPException(status_code=400, detail="역할 이름은 최소 2자입니다.")
    if body.name in ROLE_SCOPES:
        raise HTTPException(status_code=409, detail="내장 역할 이름과 중복됩니다.")

    # 스코프 검증
    invalid = [s for s in body.scopes if s not in ALL_SCOPES and s != "*"]
    if invalid:
        raise HTTPException(
            status_code=400, detail=f"유효하지 않은 스코프: {invalid}"
        )

    # Prevent privilege escalation: only super_admin can grant wildcard scope
    is_super = admin.is_admin and getattr(admin, 'admin_role', None) == 'super_admin'
    if "*" in body.scopes:
        if not is_super:
            raise HTTPException(
                status_code=403,
                detail="Only super_admin can create roles with wildcard scope",
            )

    # Prevent assigning scopes the current user doesn't have (unless super_admin)
    if not is_super:
        admin_scopes = ROLE_SCOPES.get(getattr(admin, 'admin_role', None) or '', set())
        unauthorized = [s for s in body.scopes if s not in admin_scopes]
        if unauthorized:
            raise HTTPException(
                status_code=403,
                detail=f"Cannot grant scopes you don't have: {unauthorized}",
            )

    custom_roles = await _get_custom_roles()
    if body.name in custom_roles:
        raise HTTPException(status_code=409, detail="이미 존재하는 역할입니다.")

    custom_roles[body.name] = body.scopes
    await _save_custom_roles(custom_roles)

    # RBAC 런타임에도 반영
    ROLE_SCOPES[body.name] = set(body.scopes)

    await write_audit_log(
        db,
        action="role_created",
        actor_id=admin.id,
        resource_type="role",
        resource_id=body.name,
        new_value={"scopes": body.scopes},
    )

    return RoleResponse(name=body.name, scopes=body.scopes, is_builtin=False)


@router.patch("/admin/roles/{role_name}", response_model=RoleResponse)
async def update_role(
    role_name: str,
    body: UpdateRoleRequest,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    """역할 스코프 수정 (커스텀 역할만)."""
    if role_name in ROLE_SCOPES and role_name not in (await _get_custom_roles()):
        raise HTTPException(status_code=403, detail="내장 역할은 수정할 수 없습니다.")

    invalid = [s for s in body.scopes if s not in ALL_SCOPES and s != "*"]
    if invalid:
        raise HTTPException(
            status_code=400, detail=f"유효하지 않은 스코프: {invalid}"
        )

    # Prevent privilege escalation: only super_admin can grant wildcard scope
    is_super = admin.is_admin and getattr(admin, 'admin_role', None) == 'super_admin'
    if "*" in body.scopes:
        if not is_super:
            raise HTTPException(
                status_code=403,
                detail="Only super_admin can update roles with wildcard scope",
            )

    # Prevent assigning scopes the current user doesn't have (unless super_admin)
    if not is_super:
        admin_scopes = ROLE_SCOPES.get(getattr(admin, 'admin_role', None) or '', set())
        unauthorized = [s for s in body.scopes if s not in admin_scopes]
        if unauthorized:
            raise HTTPException(
                status_code=403,
                detail=f"Cannot grant scopes you don't have: {unauthorized}",
            )

    custom_roles = await _get_custom_roles()
    if role_name not in custom_roles:
        raise HTTPException(status_code=404, detail="역할을 찾을 수 없습니다.")

    old_scopes = custom_roles[role_name]
    custom_roles[role_name] = body.scopes
    await _save_custom_roles(custom_roles)

    # 런타임 반영
    ROLE_SCOPES[role_name] = set(body.scopes)

    await write_audit_log(
        db,
        action="role_updated",
        actor_id=admin.id,
        resource_type="role",
        resource_id=role_name,
        old_value={"scopes": old_scopes},
        new_value={"scopes": body.scopes},
    )

    return RoleResponse(name=role_name, scopes=body.scopes, is_builtin=False)


@router.delete("/admin/roles/{role_name}", status_code=204)
async def delete_role(
    role_name: str,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    """커스텀 역할 삭제."""
    if role_name in ROLE_SCOPES and role_name not in (await _get_custom_roles()):
        raise HTTPException(status_code=403, detail="내장 역할은 삭제할 수 없습니다.")

    custom_roles = await _get_custom_roles()
    if role_name not in custom_roles:
        raise HTTPException(status_code=404, detail="역할을 찾을 수 없습니다.")

    # 해당 역할 사용 중인 사용자가 있으면 viewer로 변경
    await db.execute(
        update(User)
        .where(User.admin_role == role_name)
        .values(admin_role="viewer")
    )
    await db.commit()

    del custom_roles[role_name]
    await _save_custom_roles(custom_roles)

    # 런타임에서 제거
    ROLE_SCOPES.pop(role_name, None)

    await write_audit_log(
        db,
        action="role_deleted",
        actor_id=admin.id,
        resource_type="role",
        resource_id=role_name,
    )


@router.post("/admin/users/{user_id}/roles", response_model=AdminUserRoleItem)
async def assign_role_to_user(
    user_id: uuid.UUID,
    body: AssignRoleRequest,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    """사용자에게 역할 할당."""
    # 역할 유효성 검증
    custom_roles = await _get_custom_roles()
    all_roles = _get_all_roles(custom_roles)
    if body.role not in all_roles:
        raise HTTPException(status_code=400, detail=f"존재하지 않는 역할: {body.role}")

    # ── Privilege escalation guards (S-3) ────────────────────────────────
    is_super = admin.is_admin and getattr(admin, "admin_role", None) == "super_admin"
    target_role_scopes = set(all_roles.get(body.role, set()))

    # ② 자기 자신에 대한 역할 변경 금지 (자가 승격 차단)
    if user_id == admin.id:
        raise HTTPException(
            status_code=403, detail="Cannot change your own role"
        )

    # ① super_admin 역할(및 와일드카드 스코프 동급 역할)의 부여는 super_admin 전용
    if not is_super and (body.role == "super_admin" or "*" in target_role_scopes):
        raise HTTPException(
            status_code=403,
            detail="Only super_admin can assign roles with wildcard scope",
        )

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")

    if not is_super:
        admin_scopes = set(
            all_roles.get(getattr(admin, "admin_role", None) or "", set())
        )

        # ① (회수 측) 현재 super_admin/와일드카드 역할 보유자의 역할 변경도 super_admin 전용
        current_role = getattr(user, "admin_role", None) if user.is_admin else None
        current_scopes = set(all_roles.get(current_role or "", set()))
        if current_role == "super_admin" or "*" in current_scopes:
            raise HTTPException(
                status_code=403,
                detail="Only super_admin can change a super_admin's role",
            )

        # ③ 권한 부분집합 원칙: 자신이 보유하지 않은 스코프를 포함하는 역할 부여 금지
        unauthorized = sorted(s for s in target_role_scopes if s not in admin_scopes)
        if unauthorized:
            raise HTTPException(
                status_code=403,
                detail=f"Cannot grant scopes you don't have: {unauthorized}",
            )

    old_role = user.admin_role
    user.admin_role = body.role
    if not user.is_admin:
        user.is_admin = True

    await db.commit()
    await db.refresh(user)

    # 캐시 무효화
    await invalidate_user_cache(user_id)

    await write_audit_log(
        db,
        action="user_role_assigned",
        actor_id=admin.id,
        resource_type="user",
        resource_id=str(user_id),
        old_value={"admin_role": old_role},
        new_value={"admin_role": body.role},
    )

    return AdminUserRoleItem(
        id=user.id,
        email=user.email,
        name=user.name,
        admin_role=user.admin_role,
        is_admin=user.is_admin,
    )


@router.get("/admin/roles/scopes")
async def list_all_scopes(
    admin: User = Depends(require_scope("audit.view")),
):
    """사용 가능한 모든 스코프 (카테고리별 그룹핑) 조회."""
    return {
        "categories": SCOPE_CATEGORIES,
        "all_scopes": ALL_SCOPES,
    }
