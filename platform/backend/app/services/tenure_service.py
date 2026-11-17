"""정상 누적 시간 점수 (과업 WP2 "정상적으로 누적된 시간에 따라 가중치를 부여").

점수 0~1 = 0.5 × 가입 기간 점수 + 0.5 × 실제 입장 이력 점수
    가입 기간 점수  = min(가입 일수 / 730, 1)        (2년이면 만점)
    입장 이력 점수  = min(실제 입장한 공연 수 / 10, 1)   (event_admissions, 본인 소유 티켓)
    "정상적"이 아니면 0:
        - 최근 365일 안에 제재(impose)를 받은 계정은 해제 여부와 무관하게 0
결과는 users.history_score 에 저장하고 ts_weight_snapshots 에 시계열로 남긴다.
가중치 정책의 tenure_coef 가 0 이 아니면 응모 마감 시 이 점수가 가중치에 들어간다.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event_admission import EventAdmission
from app.models.sanction import AccountSanction, SanctionAction
from app.models.ticket import Ticket
from app.models.user import User
from app.services.timeseries_log import record_weight_snapshot

logger = logging.getLogger(__name__)

ACCOUNT_DAYS_FULL = 730
ADMISSIONS_FULL = 10
SANCTION_LOOKBACK_DAYS = 365


def tenure_score(account_days: int, admissions: int, sanctioned_recently: bool) -> float:
    if sanctioned_recently:
        return 0.0
    age = min(max(account_days, 0) / ACCOUNT_DAYS_FULL, 1.0)
    attended = min(max(admissions, 0) / ADMISSIONS_FULL, 1.0)
    return round(0.5 * age + 0.5 * attended, 6)


class TenureService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def compute(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
        if not user_ids:
            return {}
        now = datetime.now(UTC)
        users = (await self.session.execute(select(User.id, User.created_at).where(User.id.in_(user_ids)))).all()
        admissions = dict(
            (
                await self.session.execute(
                    select(Ticket.current_owner_id, func.count(distinct(EventAdmission.event_id)))
                    .join(Ticket, Ticket.id == EventAdmission.ticket_id)
                    .where(Ticket.current_owner_id.in_(user_ids))
                    .group_by(Ticket.current_owner_id)
                )
            ).all()
        )
        sanctioned = set(
            (
                await self.session.execute(
                    select(distinct(AccountSanction.user_id)).where(
                        AccountSanction.user_id.in_(user_ids),
                        AccountSanction.action == SanctionAction.IMPOSE,
                        AccountSanction.created_at >= now - timedelta(days=SANCTION_LOOKBACK_DAYS),
                    )
                )
            ).scalars().all()
        )
        out: dict[uuid.UUID, dict] = {}
        for uid, created_at in users:
            created = created_at if created_at and created_at.tzinfo else (created_at or now).replace(tzinfo=UTC)
            days = max(0, (now - created).days)
            n = int(admissions.get(uid, 0))
            out[uid] = {
                "account_days": days,
                "admissions": n,
                "sanctioned_recently": uid in sanctioned,
                "score": tenure_score(days, n, uid in sanctioned),
            }
        return out

    async def refresh(self, user_ids: list[uuid.UUID]) -> int:
        """점수를 users.history_score 에 반영하고 시계열 스냅숏을 남긴다."""
        results = await self.compute(user_ids)
        for uid, r in results.items():
            user = await self.session.get(User, uid)
            if user is None:
                continue
            user.history_score = r["score"]
            await record_weight_snapshot(
                self.session,
                user_id=uid,
                tenure_score=r["score"],
                account_days=r["account_days"],
                admissions=r["admissions"],
                meta={"sanctioned_recently": r["sanctioned_recently"]},
            )
        await self.session.flush()
        return len(results)

    async def refresh_all(self, batch: int = 1000) -> int:
        total = 0
        last: uuid.UUID | None = None
        while True:
            q = select(User.id).order_by(User.id).limit(batch)
            if last is not None:
                q = q.where(User.id > last)
            ids = list((await self.session.execute(q)).scalars().all())
            if not ids:
                break
            total += await self.refresh(ids)
            await self.session.commit()
            last = ids[-1]
        logger.info("tenure scores refreshed: %d users", total)
        return total
