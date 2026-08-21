"""GDPR/PIPA 서비스 — 계정 삭제, 데이터 내보내기, 동의 관리."""

import hashlib
import logging
import uuid
from datetime import datetime, timezone, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.user import User
from app.models.consent import UserConsent, ConsentPurpose
from app.models.order import Order
from app.models.ticket import Ticket
from app.models.bid import Bid

logger = logging.getLogger(__name__)

# 계정 삭제 유예 기간 (PII_RETENTION_DAYS config로 덮어쓸 수 있음)
DELETION_GRACE_DAYS = settings.PII_RETENTION_DAYS


class GDPRService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def request_account_deletion(self, user_id: uuid.UUID) -> dict:
        """계정 삭제 요청 — 30일 유예 기간 설정."""
        result = await self.session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")

        if user.deleted_at is not None:
            raise ValueError("이미 삭제 요청된 계정입니다.")

        now = datetime.now(timezone.utc)
        user.deletion_requested_at = now
        user.deleted_at = now + timedelta(days=DELETION_GRACE_DAYS)
        user.is_active = False

        # P0-12: Invalidate cache BEFORE commit to close race window
        from app.core.redis import invalidate_user_cache
        await invalidate_user_cache(user_id)
        await self.session.commit()
        logger.info("계정 삭제 요청 — user_id=%s, 예정일=%s", user_id, user.deleted_at)
        # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
        await invalidate_user_cache(user_id)

        return {
            "user_id": str(user_id),
            "deletion_requested_at": now.isoformat(),
            "scheduled_deletion_at": user.deleted_at.isoformat(),
            "grace_days": DELETION_GRACE_DAYS,
        }

    async def cancel_account_deletion(self, user_id: uuid.UUID) -> dict:
        """계정 삭제 요청 취소 (유예 기간 내)."""
        result = await self.session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")

        if user.deletion_requested_at is None:
            raise ValueError("삭제 요청이 없습니다.")

        user.deletion_requested_at = None
        user.deleted_at = None
        user.is_active = True

        # P0-12: Invalidate cache BEFORE commit to close race window
        from app.core.redis import invalidate_user_cache
        await invalidate_user_cache(user_id)
        await self.session.commit()
        logger.info("계정 삭제 취소 — user_id=%s", user_id)
        # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
        await invalidate_user_cache(user_id)

        return {"user_id": str(user_id), "detail": "삭제 요청이 취소되었습니다."}

    async def execute_account_deletion(self, user_id: uuid.UUID) -> dict:
        """실제 계정 삭제 (개인정보 익명화).

        이름 → '탈퇴회원', 이메일 → hash, 전화 → null 등.
        """
        result = await self.session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")

        email_hash = hashlib.sha256(user.email.encode()).hexdigest()[:16]
        user.name = "탈퇴회원"
        user.email = f"deleted_{email_hash}@{settings.WITHDRAWN_EMAIL_DOMAIN}"
        user.phone = None
        user.hashed_password = "DELETED"
        user.avatar_url = None
        user.bio = None
        user.ci_hash = None
        user.di_hash = None
        user.date_of_birth = None
        user.oauth_provider = None
        user.oauth_id = None
        user.is_active = False
        user.notification_preferences = None
        user.residential_city = None
        user.residential_district = None

        # 동의 기록도 철회 처리
        consents = (
            (await self.session.execute(select(UserConsent).where(UserConsent.user_id == user_id)))
            .scalars()
            .all()
        )
        now = datetime.now(timezone.utc)
        for consent in consents:
            consent.consented = False
            consent.withdrawn_at = now

        # Scrub PII stored on the user's orders (payment_metadata JSON + phone/
        # email columns mirrored onto Order by payment providers). The order row
        # itself is preserved for accounting/legal retention — only identifying
        # fields are wiped.
        user_orders = (
            (await self.session.execute(select(Order).where(Order.user_id == user_id)))
            .scalars()
            .all()
        )
        _PII_META_KEYS = {
            "buyer_name",
            "buyer_email",
            "buyer_phone",
            "billing_name",
            "billing_email",
            "billing_phone",
            "card_number",
            "card_holder",
            "card",
        }
        for order in user_orders:
            meta = order.payment_metadata or {}
            if meta:
                scrubbed = {
                    k: ("[redacted]" if k in _PII_META_KEYS else v)
                    for k, v in meta.items()
                }
                order.payment_metadata = scrubbed
            # Top-level mirror fields — only scrub columns that exist
            for _field in (
                "buyer_name",
                "buyer_email",
                "buyer_phone",
                "buyer_phone_lookup_hash",
            ):
                if hasattr(order, _field):
                    setattr(order, _field, None)

        # P0-12: Invalidate cache BEFORE commit to close race window
        from app.core.redis import invalidate_user_cache
        await invalidate_user_cache(user_id)
        await self.session.commit()
        logger.info("계정 익명화 완료 — user_id=%s", user_id)
        # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
        await invalidate_user_cache(user_id)

        return {"user_id": str(user_id), "detail": "개인정보가 익명화되었습니다."}

    async def export_user_data(self, user_id: uuid.UUID) -> dict:
        """GDPR 데이터 이식성 — 사용자 전체 데이터 JSON 수집."""
        # 사용자 기본 정보
        result = await self.session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")

        user_data = {
            "id": str(user.id),
            "email": user.email,
            "name": user.name,
            "phone": user.phone,
            "is_verified": user.is_verified,
            "verification_level": user.verification_level,
            "preferred_language": user.preferred_language,
            "timezone": user.timezone,
            "created_at": user.created_at.isoformat() if user.created_at else None,
        }

        # 동의 기록
        consents = (
            (await self.session.execute(select(UserConsent).where(UserConsent.user_id == user_id)))
            .scalars()
            .all()
        )
        consent_data = [
            {
                "purpose": c.purpose,
                "consented": c.consented,
                "consented_at": c.consented_at.isoformat() if c.consented_at else None,
                "withdrawn_at": c.withdrawn_at.isoformat() if c.withdrawn_at else None,
            }
            for c in consents
        ]

        # 주문 기록
        orders = (
            (await self.session.execute(select(Order).where(Order.user_id == user_id)))
            .scalars()
            .all()
        )
        order_data = [
            {
                "id": str(o.id),
                "event_id": str(o.event_id),
                "status": o.status.value if hasattr(o.status, "value") else str(o.status),
                "total_amount": float(o.total_amount) if o.total_amount else None,
                "created_at": o.created_at.isoformat() if o.created_at else None,
            }
            for o in orders
        ]

        # 티켓 기록
        tickets = (
            (await self.session.execute(select(Ticket).where(Ticket.owner_id == user_id)))
            .scalars()
            .all()
        )
        ticket_data = [
            {
                "id": str(t.id),
                "event_id": str(t.event_id),
                "status": t.status.value if hasattr(t.status, "value") else str(t.status),
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in tickets
        ]

        # 입찰 기록
        bids = (
            (await self.session.execute(select(Bid).where(Bid.user_id == user_id))).scalars().all()
        )
        bid_data = [
            {
                "id": str(b.id),
                "event_id": str(b.event_id),
                "max_willingness_to_pay": float(b.max_willingness_to_pay),
                "quantity": b.quantity,
                "status": b.status.value if hasattr(b.status, "value") else str(b.status),
                "created_at": b.created_at.isoformat() if b.created_at else None,
            }
            for b in bids
        ]

        return {
            "user": user_data,
            "consents": consent_data,
            "orders": order_data,
            "tickets": ticket_data,
            "bids": bid_data,
            "exported_at": datetime.now(timezone.utc).isoformat(),
        }

    async def update_consent(
        self, user_id: uuid.UUID, purpose: str, consented: bool, ip_address: str | None = None
    ) -> dict:
        """동의 기록 업데이트."""
        # 기존 동의 확인
        result = await self.session.execute(
            select(UserConsent).where(
                UserConsent.user_id == user_id,
                UserConsent.purpose == purpose,
            )
        )
        consent = result.scalar_one_or_none()
        now = datetime.now(timezone.utc)

        if consent:
            consent.consented = consented
            consent.ip_address = ip_address
            if consented:
                consent.consented_at = now
                consent.withdrawn_at = None
            else:
                consent.withdrawn_at = now
        else:
            consent = UserConsent(
                user_id=user_id,
                purpose=purpose,
                consented=consented,
                consented_at=now if consented else None,
                withdrawn_at=None if consented else now,
                ip_address=ip_address,
            )
            self.session.add(consent)

        await self.session.commit()
        logger.info(
            "동의 업데이트 — user_id=%s, purpose=%s, consented=%s", user_id, purpose, consented
        )

        return {
            "purpose": purpose,
            "consented": consented,
            "updated_at": now.isoformat(),
        }

    async def get_consents(self, user_id: uuid.UUID) -> list[dict]:
        """사용자 동의 목록 조회."""
        result = await self.session.execute(
            select(UserConsent).where(UserConsent.user_id == user_id)
        )
        consents = result.scalars().all()

        # 모든 목적에 대해 결과 반환 (없으면 기본값)
        consent_map = {c.purpose: c for c in consents}
        all_purposes = [p.value for p in ConsentPurpose]

        items = []
        for purpose in all_purposes:
            c = consent_map.get(purpose)
            items.append(
                {
                    "purpose": purpose,
                    "consented": c.consented if c else False,
                    "consented_at": c.consented_at.isoformat() if c and c.consented_at else None,
                    "withdrawn_at": c.withdrawn_at.isoformat() if c and c.withdrawn_at else None,
                }
            )

        return items
