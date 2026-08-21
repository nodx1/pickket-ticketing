"""역할 기반 접근 제어 (RBAC).

6개 역할, 스코프 기반 권한 체크.
"""

from fastapi import HTTPException


ROLE_SCOPES: dict[str, set[str]] = {
    "super_admin": {"*"},
    "admin": {
        "users.manage",
        "events.manage",
        "organizers.manage",
        "finance.view",
        "audit.view",
        "refunds.approve",
        "settlements.review",
        "settlements.approve",
    },
    "moderator": {
        "events.manage",
        "communities.manage",
        "audit.view",
    },
    "finance_admin": {
        "finance.view",
        "finance.manage",
        "orders.manage",
        "organizers.manage",
        "refunds.approve",
        "settlements.review",
    },
    "cs_agent": {
        "users.view",
        "orders.manage",
        "notifications.send",
        "refunds.request",
    },
    "viewer": {
        "audit.view",
    },
}


def check_scope(admin_role: str | None, required_scope: str) -> bool:
    """역할에 필요한 스코프가 있는지 확인."""
    if not admin_role:
        return False
    scopes = ROLE_SCOPES.get(admin_role, set())
    return "*" in scopes or required_scope in scopes


def require_scope(admin_role: str | None, required_scope: str) -> None:
    """스코프 검증. 없으면 403."""
    if not check_scope(admin_role, required_scope):
        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions: requires '{required_scope}'",
        )
