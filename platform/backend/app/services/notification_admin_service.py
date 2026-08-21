"""Admin notification service — send/broadcast notifications."""

import uuid
import logging

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.notification import NotificationModel

logger = logging.getLogger(__name__)


class NotificationAdminService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def send_to_users(
        self,
        sender_id: uuid.UUID,
        user_ids: list[uuid.UUID],
        title: str,
        message: str,
        notification_type: str = "admin_notice",
    ) -> int:
        """Send notification to specific users. Returns count of created notifications."""
        created = 0
        for uid in user_ids:
            notif = NotificationModel(
                id=uuid.uuid4(),
                user_id=uid,
                type=notification_type,
                message=message,
                data={"title": title, "sender_id": str(sender_id)},
                is_read=False,
                is_sent=True,
            )
            self.session.add(notif)
            created += 1
        await self.session.commit()
        return created

    async def broadcast(
        self,
        sender_id: uuid.UUID,
        target: str,
        title: str,
        message: str,
    ) -> int:
        """Broadcast notification to all users or filtered group.

        target: "all" = all active users, "organizers" = is_organizer=True, "users" = is_organizer=False
        Returns count of created notifications.
        """
        query = select(User.id).where(User.is_active == True)
        if target == "organizers":
            query = query.where(User.is_organizer == True)
        elif target == "users":
            query = query.where(User.is_organizer == False)
        # "all" = no extra filter

        # Keyset-paginate user IDs in bounded batches so a broadcast to 100K+
        # users never materializes all IDs/ORM objects at once. Avoids mixing a
        # server-side stream cursor with flush() on the same session (each batch
        # is an independent SELECT). Single commit at the end keeps it atomic.
        BATCH_SIZE = 500
        data = {"title": title, "sender_id": str(sender_id), "target": target}
        created = 0
        last_id: uuid.UUID | None = None

        while True:
            batch_query = query.order_by(User.id).limit(BATCH_SIZE)
            if last_id is not None:
                batch_query = batch_query.where(User.id > last_id)
            rows = (await self.session.execute(batch_query)).all()
            if not rows:
                break
            batch = [
                NotificationModel(
                    id=uuid.uuid4(),
                    user_id=row[0],
                    type="admin_broadcast",
                    message=message,
                    data=data,
                    is_read=False,
                    is_sent=True,
                )
                for row in rows
            ]
            self.session.add_all(batch)
            await self.session.flush()
            created += len(batch)
            last_id = rows[-1][0]
            if len(rows) < BATCH_SIZE:
                break

        await self.session.commit()
        return created

    async def get_history(self, skip: int = 0, limit: int = 50) -> tuple[list[dict], int]:
        """Get admin notification sending history.

        Aggregates notifications by type + message + data->title to group broadcast batches.
        """
        # Group admin notifications by message + type to find batches
        admin_types = ["admin_notice", "admin_broadcast"]
        base = (
            select(
                func.min(NotificationModel.created_at).label("created_at"),
                NotificationModel.type,
                NotificationModel.message,
                func.count(NotificationModel.id).label("recipient_count"),
            )
            .where(NotificationModel.type.in_(admin_types))
            .group_by(NotificationModel.type, NotificationModel.message)
            .order_by(func.min(NotificationModel.created_at).desc())
        )

        # Count total groups
        count_subq = base.subquery()
        count_result = await self.session.execute(select(func.count()).select_from(count_subq))
        total = count_result.scalar() or 0

        result = await self.session.execute(base.offset(skip).limit(limit))
        rows = result.all()

        notifications = []
        for row in rows:
            # Fetch one notification from this group to get data (title, sender_id)
            sample = await self.session.execute(
                select(NotificationModel)
                .where(
                    NotificationModel.type == row.type,
                    NotificationModel.message == row.message,
                )
                .order_by(NotificationModel.created_at)
                .limit(1)
            )
            sample_notif = sample.scalar_one_or_none()
            data = sample_notif.data if sample_notif and sample_notif.data else {}
            row_id = sample_notif.id if sample_notif else uuid.uuid4()

            notifications.append(
                {
                    "id": row_id,
                    "sender_id": uuid.UUID(
                        data.get("sender_id", "00000000-0000-0000-0000-000000000000")
                    ),
                    "target": data.get("target", "specific"),
                    "title": data.get("title", ""),
                    "message": row.message,
                    "recipient_count": row.recipient_count,
                    "created_at": row.created_at,
                }
            )
        return notifications, total
