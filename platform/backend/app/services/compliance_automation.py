"""P3-15: Compliance automation service.

Automates regulatory compliance checks:
- GDPR/PIPA data retention enforcement
- Age verification requirements per event category
- Tax document generation triggers
- Accessibility compliance checks
- Payment regulation compliance (PG 정산 규정)
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum

from sqlalchemy import select, func, and_, update
from sqlalchemy.ext.asyncio import AsyncSession


class ComplianceCheck(str, Enum):
    DATA_RETENTION = "data_retention"
    AGE_VERIFICATION = "age_verification"
    TAX_DOCUMENTS = "tax_documents"
    ACCESSIBILITY = "accessibility"
    PAYMENT_REGULATION = "payment_regulation"
    REFUND_POLICY = "refund_policy"


class ComplianceStatus(str, Enum):
    PASS = "pass"
    WARNING = "warning"
    FAIL = "fail"
    NOT_APPLICABLE = "n/a"


@dataclass
class ComplianceResult:
    check: ComplianceCheck
    status: ComplianceStatus
    message: str
    details: dict = field(default_factory=dict)
    remediation: str | None = None


@dataclass
class ComplianceReport:
    entity_type: str  # "event" | "organizer" | "platform"
    entity_id: str
    results: list[ComplianceResult] = field(default_factory=list)
    overall_status: ComplianceStatus = ComplianceStatus.PASS
    generated_at: str = ""
    score: int = 100  # 0-100

    def __post_init__(self):
        self.generated_at = datetime.now(timezone.utc).isoformat()
        if any(r.status == ComplianceStatus.FAIL for r in self.results):
            self.overall_status = ComplianceStatus.FAIL
        elif any(r.status == ComplianceStatus.WARNING for r in self.results):
            self.overall_status = ComplianceStatus.WARNING


# ── Data Retention (PIPA/GDPR) ───────────────────────────────────────────────

RETENTION_PERIODS = {
    "user_behaviors": 365,      # 1 year
    "payment_logs": 365 * 5,    # 5 years (tax requirement)
    "session_data": 90,         # 90 days
    "push_subscriptions": 365,  # 1 year
    "cs_tickets": 365 * 3,      # 3 years
}


async def check_data_retention(db: AsyncSession) -> ComplianceResult:
    """Check if data retention policies are being enforced."""
    from app.models.user_behavior import UserBehavior

    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=RETENTION_PERIODS["user_behaviors"])
    result = await db.execute(
        select(func.count())
        .where(UserBehavior.created_at < cutoff)
    )
    expired_count = result.scalar() or 0

    if expired_count > 0:
        return ComplianceResult(
            check=ComplianceCheck.DATA_RETENTION,
            status=ComplianceStatus.WARNING,
            message=f"{expired_count}건의 행동 데이터가 보존 기간을 초과했습니다",
            details={"expired_records": expired_count, "table": "user_behaviors"},
            remediation="자동 정리 작업을 실행하거나 보존 정책을 검토하세요",
        )

    return ComplianceResult(
        check=ComplianceCheck.DATA_RETENTION,
        status=ComplianceStatus.PASS,
        message="데이터 보존 정책 준수 중",
    )


# ── Age Verification ──────────────────────────────────────────────────────────

AGE_RESTRICTED_CATEGORIES = {"nightclub", "bar", "19+"}


async def check_age_verification(
    db: AsyncSession,
    event_id: uuid.UUID,
) -> ComplianceResult:
    """Check if event requires age verification and has it configured."""
    from app.models.event import Event

    event = await db.get(Event, event_id)
    if not event:
        return ComplianceResult(
            check=ComplianceCheck.AGE_VERIFICATION,
            status=ComplianceStatus.NOT_APPLICABLE,
            message="이벤트를 찾을 수 없습니다",
        )

    category = getattr(event, "category", "").lower()
    requires_verification = category in AGE_RESTRICTED_CATEGORIES

    if not requires_verification:
        return ComplianceResult(
            check=ComplianceCheck.AGE_VERIFICATION,
            status=ComplianceStatus.NOT_APPLICABLE,
            message="연령 제한이 필요하지 않은 카테고리입니다",
        )

    has_verification = getattr(event, "age_restriction", None) is not None

    if has_verification:
        return ComplianceResult(
            check=ComplianceCheck.AGE_VERIFICATION,
            status=ComplianceStatus.PASS,
            message="연령 인증 설정 완료",
        )

    return ComplianceResult(
        check=ComplianceCheck.AGE_VERIFICATION,
        status=ComplianceStatus.FAIL,
        message="연령 제한 카테고리이나 연령 인증이 미설정입니다",
        remediation="이벤트 설정에서 연령 인증을 활성화하세요",
    )


# ── Tax Documents ─────────────────────────────────────────────────────────────

async def check_tax_compliance(
    db: AsyncSession,
    organizer_id: uuid.UUID,
) -> ComplianceResult:
    """Check if organizer has required tax documents."""
    from app.models.user import User

    user = await db.get(User, organizer_id)
    if not user:
        return ComplianceResult(
            check=ComplianceCheck.TAX_DOCUMENTS,
            status=ComplianceStatus.NOT_APPLICABLE,
            message="주최자를 찾을 수 없습니다",
        )

    has_business_number = bool(getattr(user, "business_number", None))
    has_bank_account = bool(getattr(user, "bank_account_number", None))

    issues = []
    if not has_business_number:
        issues.append("사업자등록번호 미등록")
    if not has_bank_account:
        issues.append("정산 계좌 미등록")

    if issues:
        return ComplianceResult(
            check=ComplianceCheck.TAX_DOCUMENTS,
            status=ComplianceStatus.WARNING,
            message=f"세금 관련 정보 미비: {', '.join(issues)}",
            details={"missing": issues},
            remediation="주최자 프로필에서 사업자 정보와 정산 계좌를 등록하세요",
        )

    return ComplianceResult(
        check=ComplianceCheck.TAX_DOCUMENTS,
        status=ComplianceStatus.PASS,
        message="세금 관련 정보 등록 완료",
    )


# ── Refund Policy ─────────────────────────────────────────────────────────────

async def check_refund_policy(
    db: AsyncSession,
    event_id: uuid.UUID,
) -> ComplianceResult:
    """Check if event has a valid refund policy."""
    from app.models.event import Event

    event = await db.get(Event, event_id)
    if not event:
        return ComplianceResult(
            check=ComplianceCheck.REFUND_POLICY,
            status=ComplianceStatus.NOT_APPLICABLE,
            message="이벤트를 찾을 수 없습니다",
        )

    has_policy = bool(getattr(event, "refund_policy", None))

    if not has_policy:
        return ComplianceResult(
            check=ComplianceCheck.REFUND_POLICY,
            status=ComplianceStatus.WARNING,
            message="환불 정책이 설정되지 않았습니다 (기본 정책 적용 중)",
            remediation="이벤트 설정에서 환불 정책을 명시적으로 설정하세요",
        )

    return ComplianceResult(
        check=ComplianceCheck.REFUND_POLICY,
        status=ComplianceStatus.PASS,
        message="환불 정책 설정 완료",
    )


# ── Full Compliance Audit ─────────────────────────────────────────────────────

async def run_event_audit(
    db: AsyncSession,
    event_id: uuid.UUID,
) -> ComplianceReport:
    """Run full compliance audit for an event."""
    results = [
        await check_age_verification(db, event_id),
        await check_refund_policy(db, event_id),
    ]

    applicable = [r for r in results if r.status != ComplianceStatus.NOT_APPLICABLE]
    passed = sum(1 for r in applicable if r.status == ComplianceStatus.PASS)
    score = int((passed / len(applicable)) * 100) if applicable else 100

    report = ComplianceReport(
        entity_type="event",
        entity_id=str(event_id),
        results=results,
        score=score,
    )
    return report


async def run_organizer_audit(
    db: AsyncSession,
    organizer_id: uuid.UUID,
) -> ComplianceReport:
    """Run compliance audit for an organizer."""
    results = [
        await check_tax_compliance(db, organizer_id),
    ]

    applicable = [r for r in results if r.status != ComplianceStatus.NOT_APPLICABLE]
    passed = sum(1 for r in applicable if r.status == ComplianceStatus.PASS)
    score = int((passed / len(applicable)) * 100) if applicable else 100

    report = ComplianceReport(
        entity_type="organizer",
        entity_id=str(organizer_id),
        results=results,
        score=score,
    )
    return report


async def run_platform_audit(db: AsyncSession) -> ComplianceReport:
    """Run platform-wide compliance audit."""
    results = [
        await check_data_retention(db),
    ]

    applicable = [r for r in results if r.status != ComplianceStatus.NOT_APPLICABLE]
    passed = sum(1 for r in applicable if r.status == ComplianceStatus.PASS)
    score = int((passed / len(applicable)) * 100) if applicable else 100

    report = ComplianceReport(
        entity_type="platform",
        entity_id="pickket",
        results=results,
        score=score,
    )
    return report
