"""Celery task for auto-drawing lottery pools whose application period has ended."""

import logging
import random
from datetime import datetime, timezone, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.pool import NullPool

from celery import shared_task

from app.core.database import SyncSession
from app.core.config import settings
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)


async def _draw_pool(pool_id):
    """Run the lottery draw for a single pool via the service layer.

    Celery worker 의 영속 event loop 에서 실행한다. 자체 engine/NullPool 은 추첨
    트랜잭션의 독립성을 유지하고 호출 종료 시 명시적으로 dispose 한다.
    """
    from app.core.redis import close_redis, init_redis
    from app.services.lottery_service import LotteryService

    db_url = settings.DATABASE_URL
    if db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(db_url, poolclass=NullPool, echo=False)
    # 🔴 Celery 워커에는 API 서버의 시작 훅(init_redis)이 없다. 그대로 두면 추첨의 분산 락
    #    (redis_lock)이 「Redis not initialized」로 실패해 **마감 뒤 자동 추첨이 한 건도 안 된다**
    #    (2026-11-27 로컬 실측: 밀린 추첨 6건 모두 실패, pools_drawn=0). 수동 추첨(API)은 서버가
    #    Redis 를 이미 열어 둬서 이 문제를 가렸다. queue_processor 와 같은 방식으로 이 워커
    #    프로세스의 영속 루프(run_async)에서 추첨마다 열고 끝나면 닫는다.
    await init_redis()
    try:
        # F-1 commit-reveal: 응모 마감(deadline 도래) 시점 훅 — 추첨과
        # 분리된 세션/트랜잭션에서 사전 시드 커밋을 먼저 영속화한다.
        # 신규 풀은 생성 시점에 이미 커밋이 있어 no-op, legacy 풀만 백필.
        # (ensure_commitment 내부에서 commit() — draw 가 실패/재실행돼도
        #  커밋(시드)은 불변으로 남아 사후 시드 재추첨이 탐지 가능)
        async with AsyncSession(engine, expire_on_commit=False) as commit_session:
            await LotteryService(commit_session).ensure_commitment(pool_id)

        async with AsyncSession(engine, expire_on_commit=False) as session:
            service = LotteryService(session)
            result = await service.draw(pool_id)
            await session.commit()
            return result
    finally:
        await close_redis()
        await engine.dispose()


@shared_task(
    name="app.tasks.lottery_draw.auto_draw_lotteries",
    bind=True,
    max_retries=5,
    acks_late=True,
)
def auto_draw_lotteries(self):
    """Auto-draw lottery pools whose application period has ended.

    인터파크 방식 — phase_configs 의 lottery phase ends_at 을 진짜 deadline 으로 사용.
    phase_configs 가 없는 이벤트는 fallback 으로 pool.created_at + lottery_application_hours.
    deadline 도래 + 풀 OPEN → LotteryService.draw() 호출 (weighted, orders, tickets, audit).
    """
    # #22: 60s 주기 — 동시 실행 시 같은 풀을 두 인스턴스가 추첨 시도할 수 있어
    # task-level single-flight 락으로 방어 (draw 내부 가드가 최종 방어선).
    from app.tasks._locks import single_flight

    with single_flight("lock:beat:auto_draw_lotteries", ttl=300) as _acquired:
        if not _acquired:
            logger.info("auto_draw_lotteries already running — skipping (in_progress)")
            return {"skipped": True, "reason": "in_progress"}
        return _run_auto_draw_lotteries(self)


def _run_auto_draw_lotteries(self):
    from app.models.lottery import LotteryPool, LotteryPoolStatus
    from app.models.event import Event, EventStatus, SeatTier
    from app.models.phase_config import PhaseConfig

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)

        # Find all open lottery pools — 취소된 이벤트의 풀은 건너뜀
        # (이벤트 취소 시 결제요구 주문 생성·AP 소진 방지; LotteryService._draw_inner
        #  에도 동일 가드가 있어 이중 방어)
        open_pools = (
            session.execute(
                select(LotteryPool)
                .join(Event, Event.id == LotteryPool.event_id)
                .where(
                    LotteryPool.status == LotteryPoolStatus.OPEN,
                    Event.status != EventStatus.CANCELLED,
                )
            )
            .scalars()
            .all()
        )

        # Batch-load tiers + phase_configs (lottery phase) for involved events
        tier_ids = {pool.tier_id for pool in open_pools}
        event_ids = {pool.event_id for pool in open_pools}
        if tier_ids:
            tiers_result = (
                session.execute(select(SeatTier).where(SeatTier.id.in_(tier_ids))).scalars().all()
            )
            tier_map = {tier.id: tier for tier in tiers_result}
        else:
            tier_map = {}

        # phase_configs 의 lottery phase ends_at — 이벤트별
        phase_end_map: dict = {}
        if event_ids:
            phase_rows = (
                session.execute(
                    select(PhaseConfig).where(
                        PhaseConfig.event_id.in_(event_ids),
                        PhaseConfig.phase == "lottery",
                    )
                )
                .scalars()
                .all()
            )
            for pc in phase_rows:
                # 이벤트당 lottery phase 가 여러 개면 가장 늦은 ends_at 사용
                cur = phase_end_map.get(pc.event_id)
                if cur is None or pc.ends_at > cur:
                    phase_end_map[pc.event_id] = pc.ends_at

        # Determine which pools are past their application deadline
        pools_to_draw = []
        for pool in open_pools:
            if pool.status != LotteryPoolStatus.OPEN:
                continue

            tier = tier_map.get(pool.tier_id)
            if not tier:
                continue

            # phase_configs ends_at 우선, 없으면 fallback
            phase_end = phase_end_map.get(pool.event_id)
            if phase_end is not None:
                application_deadline = phase_end
            else:
                application_deadline = pool.created_at + timedelta(
                    hours=tier.lottery_application_hours
                )

            pool_deadline = (
                application_deadline.replace(tzinfo=None)
                if application_deadline.tzinfo
                else application_deadline
            )
            now_naive = now.replace(tzinfo=None) if now.tzinfo else now

            if now_naive < pool_deadline:
                continue

            pools_to_draw.append(pool.id)

        # Delegate each draw to the service (handles winners, orders, tickets, audit)
        drawn_count = 0
        failed_pools: list[dict] = []
        for pool_id in pools_to_draw:
            try:
                run_async(_draw_pool(pool_id))
                drawn_count += 1
            except ValueError as exc:
                # Pool not found or already drawn -- benign, log and continue
                logger.warning("Skipping pool %s: %s", pool_id, exc)
            except Exception as exc:  # noqa: BLE001
                # #28: per-pool 실패를 더 이상 조용히 삼키지 않는다 — 태스크는
                # 성공으로 끝나므로 task_failure 핸들러(DLQ/텔레그램)가 발화하지
                # 않는다. 실패 풀을 모아 Sentry + 운영 알림으로 명시 보고한다.
                logger.exception("Failed to draw pool %s", pool_id)
                failed_pools.append({"pool_id": str(pool_id), "error": str(exc)[:300]})
                try:
                    import sentry_sdk

                    sentry_sdk.capture_exception(exc)
                except Exception:
                    logger.debug("sentry capture skipped for pool %s", pool_id, exc_info=True)

        # #28: 실패 풀이 있으면 운영팀에 명시 알림 (매분 재시도하며 묵음 누적 방지)
        if failed_pools:
            try:
                from app.core.alerting import send_ops_alert_sync

                send_ops_alert_sync(
                    "critical",
                    f"추첨 풀 {len(failed_pools)}건 실패 — 수동 확인 필요",
                    {
                        "실패 풀 수": len(failed_pools),
                        "성공 풀 수": drawn_count,
                        "실패 내역": failed_pools[:10],
                    },
                    mention=True,
                )
            except Exception:
                logger.warning("추첨 실패 운영 알림 발송 실패", exc_info=True)

        return {"pools_drawn": drawn_count, "pools_failed": len(failed_pools)}
    except Exception as exc:
        session.rollback()
        logger.error("auto_draw_lotteries failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
