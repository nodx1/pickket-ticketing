"""Celery task for auto-transitioning event phases based on phase_configs schedule."""

import logging
import random
from datetime import datetime, timezone

from sqlalchemy import or_, select

from celery import shared_task

from app.core.database import SyncSession

logger = logging.getLogger(__name__)


@shared_task(
    name="app.tasks.phase_transition.check_phase_transitions",
    bind=True,
    max_retries=5,
    acks_late=True,
)
def check_phase_transitions(self):
    """Auto-transition event phases based on phase_configs schedule.

    For each event with phase configs, checks if the current time has
    entered the window of the next phase. If so, updates the event's
    current_phase field.

    레벨2 컷오버 T2-PHASE: go `sale-phase-reaper` 크론이 하던
    `sale_phases.status` scheduled→open→closed 전이도 여기서 수행한다.
    go 를 제거해도 단계 상태기계가 계속 돌아야 주최자 UI·공개 current-phase 가
    현실을 반영한다. 전이는 시각 비교만으로 결정되므로 멱등하다.
    """
    from app.models.event import Event
    from app.models.phase_config import PhaseConfig

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)

        # ── (0) 단계 상태기계 전이 (go reaper 대체) ──────────────────────
        # scheduled → open: 시작 시각 도래
        to_open = (
            session.execute(
                select(PhaseConfig).where(
                    PhaseConfig.status == "scheduled",
                    PhaseConfig.starts_at <= now,
                )
            )
            .scalars()
            .all()
        )
        for pc in to_open:
            pc.status = "open"
        # open → closed: 종료 시각 도래. ends_at IS NULL 은 무기한 단계라 닫지 않는다.
        to_close = (
            session.execute(
                select(PhaseConfig).where(
                    PhaseConfig.status == "open",
                    PhaseConfig.ends_at.is_not(None),
                    PhaseConfig.ends_at <= now,
                )
            )
            .scalars()
            .all()
        )
        for pc in to_close:
            pc.status = "closed"
        status_transitions = len(to_open) + len(to_close)

        # Get all phase configs that should be active now
        # (starts_at <= now <= ends_at) ordered by event_id and sort_order
        # ⚠️ ends_at 은 nullable(무기한 단계) — `>= now` 단독 비교는 그런 단계를
        #    조용히 탈락시킨다(T2-PHASE).
        active_phases = (
            session.execute(
                select(PhaseConfig)
                .where(
                    PhaseConfig.starts_at <= now,
                    or_(PhaseConfig.ends_at.is_(None), PhaseConfig.ends_at >= now),
                )
                .order_by(PhaseConfig.event_id, PhaseConfig.sort_order.desc())
            )
            .scalars()
            .all()
        )

        # Group by event_id — take the latest (highest sort_order) active phase per event
        event_phase_map: dict[str, str] = {}
        for pc in active_phases:
            event_key = str(pc.event_id)
            if event_key not in event_phase_map:
                event_phase_map[event_key] = pc.phase

        transitions = 0
        for event_id_str, target_phase in event_phase_map.items():
            import uuid

            event_uuid = uuid.UUID(event_id_str)

            event = session.execute(
                select(Event).where(Event.id == event_uuid)
            ).scalar_one_or_none()

            if not event:
                continue

            # Idempotency: only transition if the phase is actually different
            if event.current_phase != target_phase:
                event.current_phase = target_phase
                transitions += 1

        if transitions > 0 or status_transitions > 0:
            session.commit()

        return {
            "checked_events": len(event_phase_map),
            "transitions": transitions,
            "phase_status_transitions": status_transitions,
        }
    except Exception as exc:
        session.rollback()
        logger.error("check_phase_transitions failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
