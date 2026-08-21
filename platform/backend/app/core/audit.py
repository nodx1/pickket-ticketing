"""감사 로그 데코레이터 및 유틸리티 — Phase C WP-C3.

사용법:
    @audit_log(action="payment.confirm", resource_type="order")
    async def confirm_payment(request: Request, ...):
        ...
"""

import functools
import logging
import uuid
from decimal import Decimal
from typing import Any, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.network import extract_client_ip
from app.models.audit_log import AuditLog

logger = logging.getLogger(__name__)


def _sanitize_for_json(value: Any) -> Any:
    """Normalize values so that a dict can be stored in a stdlib JSON column.

    The `types.Money` decorator returns `Decimal` from NUMERIC(12,2) columns
    (2026-04-20 P0 precision change). Callers frequently snapshot model
    attributes straight into `write_audit_log(new_value={...})`, so the dict
    ends up containing `Decimal`/`UUID`/`datetime` — none of which the
    stdlib `json` encoder handles, which raises `PendingRollbackError` on
    flush and cascades through the whole session.

    This helper walks dicts / lists recursively and converts:
      - Decimal → float
      - UUID    → str
      - datetime/date → ISO string (via isoformat)

    All other values are passed through untouched.
    """
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    # Avoid importing datetime twice — cheap `hasattr` check covers both.
    if hasattr(value, "isoformat") and callable(value.isoformat):
        try:
            return value.isoformat()
        except Exception:
            return str(value)
    if isinstance(value, dict):
        return {k: _sanitize_for_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_sanitize_for_json(v) for v in value]
    return value


def _extract_ip(request) -> str | None:
    """Request에서 클라이언트 IP 추출 (스푸핑 방지)."""
    if not request:
        return None
    return extract_client_ip(request)


def _extract_user_agent(request) -> str | None:
    """Request에서 User-Agent 추출."""
    if not request:
        return None
    return request.headers.get("user-agent", "")[:500]


async def write_audit_log(
    db: AsyncSession,
    *,
    actor_id: uuid.UUID | None = None,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    old_value: dict | None = None,
    new_value: dict | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    # WP-16: AuditEntryModel 통합 필드
    event_id: uuid.UUID | None = None,
    tier_id: uuid.UUID | None = None,
    sale_mode: str | None = None,
    # 상세통합 S2b(§6.3·§7.2): 게스트(비회원) 감사. actor_id 는 users FK 라 게스트 불가 →
    # actor_type='guest' + guest_id 로 게스트 주문/클레임/환불/매직링크 발급·소비를 기록.
    actor_type: str | None = None,
    guest_id: uuid.UUID | None = None,
) -> AuditLog:
    """감사 로그 직접 기록 (데코레이터 외부에서 사용).

    WP-16: event_id, tier_id, sale_mode 파라미터 추가.
    S2b: actor_type/guest_id 추가(게스트 감사 — actor_id 미사용 시 guest_id 로 행위자 식별).
    기존 AuditEntryModel 대신 이 함수를 사용하여 통합 감사 로그 기록.
    """
    entry = AuditLog(
        actor_id=actor_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        old_value=_sanitize_for_json(old_value),
        new_value=_sanitize_for_json(new_value),
        ip_address=ip_address,
        user_agent=user_agent,
        event_id=event_id,
        tier_id=tier_id,
        sale_mode=sale_mode,
        actor_type=actor_type,
        guest_id=guest_id,
    )
    db.add(entry)
    # flush만 수행 (커밋은 호출자가 담당)
    try:
        await db.flush()
    except Exception:
        logger.warning(
            "감사 로그 기록 실패 — action=%s, resource=%s/%s",
            action,
            resource_type,
            resource_id,
            exc_info=True,
        )
    return entry


def audit_log(action: str, resource_type: str):
    """감사 로그 데코레이터.

    FastAPI 엔드포인트 함수에 적용.
    파라미터에서 `request`, `db` (또는 `session`), `user` (또는 `admin`) 자동 추출.

    사용 예:
        @router.post("/...")
        @audit_log(action="payment.confirm", resource_type="order")
        async def confirm_payment(
            order_id: uuid.UUID,
            request: Request,
            user: User = Depends(get_current_user),
            db: AsyncSession = Depends(get_db),
        ):
            ...
    """

    def decorator(func: Callable):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            # 엔드포인트 실행
            result = await func(*args, **kwargs)

            # 감사 로그 작성 시도 (실패해도 응답에 영향 없음)
            try:
                request = kwargs.get("request")
                db = kwargs.get("db") or kwargs.get("session")
                user = kwargs.get("user") or kwargs.get("admin")

                if db is None:
                    logger.debug("감사 로그 건너뜀 — db 세션 없음 (action=%s)", action)
                    return result

                actor_id = getattr(user, "id", None) if user else None
                ip = _extract_ip(request) if request else None
                ua = _extract_user_agent(request) if request else None

                # resource_id 추출 시도: kwargs에서 common ID 패턴 탐색
                rid = None
                for key in ("order_id", "event_id", "user_id", "ticket_id", "id"):
                    if key in kwargs:
                        rid = str(kwargs[key])
                        break

                entry = AuditLog(
                    actor_id=actor_id,
                    action=action,
                    resource_type=resource_type,
                    resource_id=rid,
                    ip_address=ip,
                    user_agent=ua,
                )
                db.add(entry)
                await db.flush()

            except Exception:
                logger.warning("감사 로그 기록 실패 — action=%s", action, exc_info=True)

            return result

        return wrapper

    return decorator
