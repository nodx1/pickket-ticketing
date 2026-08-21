import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.anomaly import AnomalyLogModel
from app.services.anomaly import AnomalyResult


class AnomalyTracker:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def log_anomaly_check(
        self,
        *,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        bid_id: uuid.UUID | None = None,
        result: AnomalyResult,
        ip_address: str | None = None,
        user_agent: str | None = None,
        fingerprint_hash: str | None = None,
    ) -> AnomalyLogModel:
        """Persist one anomaly detection result."""
        log = AnomalyLogModel(
            user_id=user_id,
            event_id=event_id,
            bid_id=bid_id,
            score=result.score,
            is_blocked=result.is_anomalous,
            reasons=result.reasons,
            ip_address=ip_address,
            user_agent=user_agent,
            fingerprint_hash=fingerprint_hash,
        )
        self.db.add(log)
        await self.db.flush()
        return log

    async def get_same_ip_user_count(
        self,
        event_id: uuid.UUID,
        ip_address: str | None,
        exclude_user_id: uuid.UUID,
    ) -> int:
        """Count distinct other users using the same IP in this event."""
        if not ip_address:
            return 0
        result = await self.db.execute(
            select(func.count(func.distinct(AnomalyLogModel.user_id))).where(
                AnomalyLogModel.event_id == event_id,
                AnomalyLogModel.ip_address == ip_address,
                AnomalyLogModel.user_id != exclude_user_id,
            )
        )
        return int(result.scalar() or 0)

    async def get_same_device_user_count(
        self,
        event_id: uuid.UUID,
        fingerprint_hash: str | None,
        exclude_user_id: uuid.UUID,
    ) -> int:
        """Count distinct other users using the same fingerprint in this event."""
        if not fingerprint_hash:
            return 0
        result = await self.db.execute(
            select(func.count(func.distinct(AnomalyLogModel.user_id))).where(
                AnomalyLogModel.event_id == event_id,
                AnomalyLogModel.fingerprint_hash == fingerprint_hash,
                AnomalyLogModel.user_id != exclude_user_id,
            )
        )
        return int(result.scalar() or 0)

    async def get_user_avg_anomaly_score(self, user_id: uuid.UUID) -> float:
        """Return historical average anomaly score for a user."""
        result = await self.db.execute(
            select(func.avg(AnomalyLogModel.score)).where(AnomalyLogModel.user_id == user_id)
        )
        value = result.scalar()
        return float(value) if value is not None else 0.0
