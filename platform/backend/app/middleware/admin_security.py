"""관리자 보안 미들웨어 — YES24 해킹 대비.

1. 관리자 세션 타임아웃 (30분 비활동 시 자동 만료)
2. 위험 행위 실시간 Telegram 알림
3. MFA 미설정 관리자 접근 차단
"""

import logging
import uuid

from app.core.config import settings
from app.services.admin_mfa_service import (
    check_admin_session_active,
    is_mfa_required,
    record_admin_activity,
)

logger = logging.getLogger(__name__)

# 위험 행위 목록 — 이 행위 발생 시 Telegram 알림
CRITICAL_ADMIN_ACTIONS = {
    "admin.user.ban": "사용자 차단",
    "admin.user.role_change": "권한 변경",
    "admin.event.cancel": "이벤트 취소",
    "admin.bulk.refund": "대량 환불",
    "admin.bulk.ban": "대량 사용자 차단",
    "admin.bulk.cancel": "대량 이벤트 취소",
    "admin.role.create": "커스텀 역할 생성",
    "admin.role.update": "커스텀 역할 수정",
    "admin.role.delete": "커스텀 역할 삭제",
    "admin.role.assign": "역할 할당",
    "admin.settlement.approve": "정산 승인",
    "admin.mfa.disable": "MFA 비활성화",
}


async def enforce_admin_session(user) -> str | None:
    """관리자 세션 타임아웃 체크.

    Returns:
        None if session is valid, error message if expired.
    """
    if not getattr(user, "is_admin", False):
        return None

    # 세션 타임아웃 체크
    if not await check_admin_session_active(user.id):
        return "Admin session expired due to inactivity. Please log in again."

    # 활동 기록 갱신
    await record_admin_activity(user.id)
    return None


async def check_mfa_status(user) -> str | None:
    """MFA 미설정 관리자 접근 차단.

    Returns:
        None if MFA is set up or not required, error message otherwise.
    """
    if not is_mfa_required(user):
        return None

    if not getattr(user, "mfa_enabled", False):
        return "MFA setup required. Please set up two-factor authentication first."

    return None


async def alert_critical_admin_action(
    *,
    action: str,
    admin_id: uuid.UUID,
    admin_email: str,
    admin_role: str,
    target: str = "",
    details: dict | None = None,
    ip: str | None = None,
) -> None:
    """위험 관리자 행위 발생 시 Telegram 즉시 알림."""
    action_label = CRITICAL_ADMIN_ACTIONS.get(action, action)

    alert_details = {
        "행위": action_label,
        "관리자": f"{admin_email} ({admin_role})",
        "대상": target or "N/A",
        "IP": ip or "unknown",
    }
    if details:
        for k, v in details.items():
            alert_details[k] = str(v)[:200]

    try:
        from app.core.alerting import send_ops_alert
        await send_ops_alert(
            level="critical",
            title=f"관리자 행위 감지: {action_label}",
            details=alert_details,
            alert_key=f"admin_action:{action}:{admin_id}",
        )
    except Exception:
        logger.warning("관리자 행위 알림 발송 실패: %s", action, exc_info=True)


async def alert_suspicious_pattern(
    *,
    pattern: str,
    details: dict,
) -> None:
    """의심 패턴 탐지 시 자동 알림 (인시던트 트리거).

    예:
    - 동일 관리자가 5분 내 10건 이상 권한 변경
    - 비정상 시간대 관리자 로그인 (새벽 2-5시)
    - 새 IP에서 관리자 로그인
    """
    try:
        from app.core.alerting import send_ops_alert
        await send_ops_alert(
            level="critical",
            title=f"보안 이상 탐지: {pattern}",
            details=details,
            alert_key=f"security_pattern:{pattern}",
        )
    except Exception:
        logger.warning("보안 패턴 알림 실패: %s", pattern, exc_info=True)


async def detect_off_hours_login(admin_email: str, ip: str | None = None) -> None:
    """비정상 시간대 관리자 로그인 감지 (KST 02:00-05:00)."""
    from datetime import datetime, timezone, timedelta

    kst = timezone(timedelta(hours=9))
    now_kst = datetime.now(kst)

    if 2 <= now_kst.hour < 5:
        await alert_suspicious_pattern(
            pattern="비정상 시간대 관리자 로그인",
            details={
                "관리자": admin_email,
                "시간 (KST)": now_kst.strftime("%Y-%m-%d %H:%M:%S"),
                "IP": ip or "unknown",
            },
        )


async def detect_rapid_admin_actions(admin_id: uuid.UUID, action: str) -> None:
    """5분 내 동일 관리자의 과도한 행위 탐지."""
    try:
        from app.core.redis import get_redis, v2_key
        redis = get_redis()
        if redis is None:
            return

        key = v2_key(f"admin:action_count:{admin_id}:{action}")
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, 300)  # 5분 윈도우

        if count >= 10:
            from app.models.user import User
            await alert_suspicious_pattern(
                pattern="관리자 과도한 행위",
                details={
                    "관리자 ID": str(admin_id),
                    "행위": CRITICAL_ADMIN_ACTIONS.get(action, action),
                    "5분 내 횟수": str(count),
                },
            )
    except Exception:
        pass
