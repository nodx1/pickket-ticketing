"""Celery application configuration with bulkhead queue isolation and DLQ.

Queue topology:
  - payment   (high priority): payment_expiry, payment_capture, resale_matching
  - notification (normal): notifications, open_notice_publish, final_call_activate
  - analytics (low priority): reconciliation, tier_recalculation
  - default   (general): allocation, lottery_draw, phase_transition, queue_processor

Dead letter: failed tasks are routed to a DLQ after max retries for post-mortem.

Worker startup examples:
  celery -A app.core.celery_app worker -Q payment -c 4 --loglevel=info
  celery -A app.core.celery_app worker -Q notification -c 2 --loglevel=info
  celery -A app.core.celery_app worker -Q analytics -c 1 --loglevel=info
  celery -A app.core.celery_app worker -Q celery -c 2 --loglevel=info
  (or combine: -Q payment,notification,analytics,celery for single-worker setups)
"""

import logging

from celery import Celery
from celery.schedules import crontab
from celery.signals import setup_logging as celery_setup_logging
from celery.signals import task_failure, worker_process_init

from app.core.config import settings

logger = logging.getLogger(__name__)

CELERY_TASK_MODULES = (
    "app.tasks.allocation",
    "app.tasks.payment_expiry",
    "app.tasks.payment_capture",
    "app.tasks.lottery_draw",
    "app.tasks.notifications",
    "app.tasks.propagate_order_event",
    "app.tasks.dead_letter",

    "app.tasks.phase_transition",
    "app.tasks.resale_matching",
    "app.tasks.queue_processor",
    "app.tasks.open_notice_publish",
    "app.tasks.final_call_activate",
    "app.tasks.reconciliation",
    "app.tasks.sold_count_reconciliation",
    "app.tasks.tier_recalculation",
    "app.tasks.gdpr_cleanup",
    "app.tasks.dlq_monitor",
    "app.tasks.image_processing",
    "app.tasks.backup_task",
    "app.tasks.ops_health",
    "app.tasks.audit_retention",
    "app.tasks.etl_aggregation",
    "app.tasks.event_open_orchestrator",
    "app.tasks.purchase_processor",
    "app.tasks.weekly_curation",
    "app.services.webhook_service",
    "app.tasks.event_open_scheduler",
    "app.tasks.auto_fcfs_transition",
    "app.tasks.settlement_generate",
    "app.tasks.expire_allpass",
    # 레벨2 영역C: 조직자 메시징 dispatch(단체·캠페인·대사·동의재확인·리마인더).
    "app.tasks.messaging_dispatch",
    # 레벨2 스코프A: 주최자 대기열 구매제안 만료 리퍼(go reaper 이관).
    "app.tasks.waitlist_offer_reaper",
)

celery_app = Celery(
    "pickket",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=CELERY_TASK_MODULES,
)

# ── Queue routing: task → queue mapping ──────────────────────────────────────

TASK_QUEUE_MAP = {
    # Payment queue (high priority)
    "app.tasks.payment_expiry.check_payment_expiry": "payment",
    "app.tasks.payment_capture.auto_capture_authorized": "payment",
    "app.tasks.payment_capture.auto_void_stale_authorizations": "payment",
    "app.tasks.resale_matching.auto_match_resale_orders": "payment",
    "app.tasks.resale_matching.expire_resale_listings": "payment",
    "app.tasks.purchase_processor.process_purchase": "payment",
    # Notification queue (normal)
    "app.tasks.notifications.send_pending_notifications": "notification",

    "app.tasks.weekly_curation.push_weekly_curation": "notification",
    "app.tasks.open_notice_publish.auto_publish_open_notices": "notification",
    "app.tasks.final_call_activate.auto_activate_final_calls": "notification",
    # Analytics queue (low priority)
    "app.tasks.reconciliation.daily_reconciliation": "analytics",
    # 상시 드레인은 결제 큐 — 돈이 걸려 있어 analytics 뒤에 서면 안 된다.
    "app.tasks.reconciliation.drain_payment_attempt_recovery": "payment",
    "app.tasks.sold_count_reconciliation.reconcile_sold_counts": "analytics",
    "app.tasks.tier_recalculation.recalculate_membership_tiers": "analytics",
    "app.tasks.gdpr_cleanup.process_pending_deletions": "analytics",
    "app.tasks.dlq_monitor.monitor_dlq": "analytics",
    "app.tasks.image_processing.process_uploaded_image": "analytics",
    "app.tasks.image_processing.cleanup_orphaned_images": "analytics",
    "app.tasks.audit_retention.prune_audit_logs": "analytics",
    "app.tasks.etl_aggregation.daily_etl_aggregation": "analytics",
    "app.tasks.expire_allpass.expire_allpass_tickets": "analytics",
    # Default queue (general operations)
    "app.tasks.allocation.check_batch_windows": "celery",
    "app.tasks.allocation.check_approved_transitions": "celery",
    "app.tasks.allocation.run_allocation_async": "celery",
    "app.tasks.allocation.recover_stuck_allocations": "celery",
    "app.tasks.lottery_draw.auto_draw_lotteries": "celery",
    "app.tasks.auto_fcfs_transition.auto_transition_to_fcfs": "celery",
    "app.tasks.phase_transition.check_phase_transitions": "celery",
    "app.tasks.queue_processor.process_queues": "celery",
    # Event open orchestrator (default queue — needs DB + Redis + AWS)
    "app.tasks.event_open_orchestrator.orchestrate_event_opens": "celery",
    # Backup (analytics queue)
    "app.tasks.backup_task.auto_backup": "analytics",
    "app.tasks.ops_health.beat_heartbeat": "analytics",
    # Webhook delivery (notification queue)
    "app.services.webhook_service.deliver_webhook": "notification",
    # Event-open alerts (P6)
    "app.tasks.event_open_scheduler.check_event_open_alerts": "notification",
    "app.tasks.event_open_scheduler.send_open_sms": "notification",
    # v2→go order state propagation (webhook queue)
    "app.tasks.propagate_order_event.propagate_order_event_to_go": "webhook",
    # 레벨2 영역C: 조직자 메시징 dispatch 5종 (notification 큐)
    "app.tasks.messaging_dispatch.dispatch_messages": "notification",
    "app.tasks.messaging_dispatch.dispatch_campaigns": "notification",
    "app.tasks.messaging_dispatch.reconcile_deliveries": "notification",
    "app.tasks.messaging_dispatch.consent_reconfirm": "notification",
    "app.tasks.messaging_dispatch.reminders": "notification",
    # 레벨2 스코프A: 대기열 리퍼 (notification 큐)
    "app.tasks.waitlist_offer_reaper.reap_expired_offers": "notification",
    # Dead-letter sink (dlq queue)
    "dlq.dead_letter": "dlq",
}

celery_app.conf.update(
    imports=CELERY_TASK_MODULES,
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Seoul",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_soft_time_limit=1800,   # 30 min soft limit
    task_time_limit=1860,         # 31 min hard kill
    # Queue definitions: declare all queues so workers can consume from any subset
    task_queues={
        "celery": {"exchange": "celery", "routing_key": "celery"},
        "payment": {"exchange": "payment", "routing_key": "payment"},
        "notification": {"exchange": "notification", "routing_key": "notification"},
        "analytics": {"exchange": "analytics", "routing_key": "analytics"},
        "webhook": {"exchange": "webhook", "routing_key": "webhook"},
        "dlq": {"exchange": "dlq", "routing_key": "dlq"},
    },
    # Route tasks to their designated queues
    task_routes=TASK_QUEUE_MAP,
    # Default queue for unrouted tasks
    task_default_queue="celery",
    beat_schedule={
        "check-batch-windows": {
            "task": "app.tasks.allocation.check_batch_windows",
            "schedule": 60.0,  # Every minute
        },
        "check-approved-transitions": {
            "task": "app.tasks.allocation.check_approved_transitions",
            "schedule": 60.0,  # Every minute
        },
        "check-payment-expiry": {
            "task": "app.tasks.payment_expiry.check_payment_expiry",
            "schedule": 30.0,  # Every 30 seconds
        },
        "sweep-pending-webhooks": {
            "task": "app.services.webhook_service.sweep_pending_webhooks",
            "schedule": 60.0,  # P1-8: broker 장애로 유실된 PENDING delivery 재큐
        },
        "auto-capture-authorized": {
            "task": "app.tasks.payment_capture.auto_capture_authorized",
            "schedule": 300.0,  # Every 5 minutes
        },
        "auto-void-stale-authorizations": {
            "task": "app.tasks.payment_capture.auto_void_stale_authorizations",
            # 간격형 중 유일하게 1시간 이상 남아 있던 항목. 주기는 그대로(매시)지만
            # **시각 고정**으로 바꾼다 — 재배포가 1시간 안에 두 번 겹치면 간격형은 굶는다.
            # 2026-08-02 에 beat 를 4번 올렸다. 동작은 안 바뀌고 신뢰도만 오른다.
            "schedule": crontab(minute=5),  # 매시 5분
        },
        "auto-draw-lotteries": {
            "task": "app.tasks.lottery_draw.auto_draw_lotteries",
            "schedule": 60.0,  # Every minute
        },
        "auto-transition-to-fcfs": {
            "task": "app.tasks.auto_fcfs_transition.auto_transition_to_fcfs",
            "schedule": 60.0,  # Every minute — phase_configs SSOT 기반 fcfs 전환
        },
        "check-phase-transitions": {
            "task": "app.tasks.phase_transition.check_phase_transitions",
            "schedule": 60.0,  # Every minute
        },
        "auto-match-resale-orders": {
            "task": "app.tasks.resale_matching.auto_match_resale_orders",
            "schedule": 30.0,  # Every 30 seconds
        },
        "expire-resale-listings": {
            "task": "app.tasks.resale_matching.expire_resale_listings",
            "schedule": 300.0,  # Every 5 minutes
        },
        "process-ticket-queues": {
            "task": "app.tasks.queue_processor.process_queues",
            "schedule": 2.0,  # Every 2 seconds
        },
        "auto-publish-open-notices": {
            "task": "app.tasks.open_notice_publish.auto_publish_open_notices",
            "schedule": 60.0,  # Every minute
        },
        "auto-activate-final-calls": {
            "task": "app.tasks.final_call_activate.auto_activate_final_calls",
            "schedule": 60.0,  # Every minute
        },
        # 🔴 결제 복구 드레인 — 분 단위 (C4·F30).
        #    승인은 됐는데 확정이 깨진 건은 **손님이 돈만 낸 상태**다. 24시간 방치하면
        #    그 사이 손님은 티켓 없이 기다리고, 문의가 와야 안다.
        #    ⟹ 탐지는 여기서 분 단위로 하고, 아래 일일 대사는 **최종 안전망**으로 남긴다.
        "payment-attempt-recovery-drain": {
            "task": "app.tasks.reconciliation.drain_payment_attempt_recovery",
            "schedule": 180.0,  # 3분
        },
        "daily-settlement-reconciliation": {
            "task": "app.tasks.reconciliation.daily_reconciliation",
            # 🔴 간격형(86400.0) 금지 — beat **기동 시점부터** 24시간을 센다.
            #    24시간 안에 beat 가 재시작되면 카운터가 0 으로 리셋돼 영원히 안 온다.
            #    실측(2026-08-02): 07-24~07-30 매일 돌다가 07-31 celery 재배포 이후
            #    daily 실행 0회. 배포가 잦을수록 절대 안 뜬다.
            "schedule": crontab(hour=1, minute=50),  # 매일 01:50 KST
        },
        "daily-sold-count-reconciliation": {
            "task": "app.tasks.sold_count_reconciliation.reconcile_sold_counts",
            "schedule": crontab(hour=1, minute=30),  # 매일 01:30 KST
        },
        "monthly-tier-recalculation": {
            "task": "app.tasks.tier_recalculation.recalculate_membership_tiers",
            # 🔴 간격형(2592000.0=30일)은 **한 번도 뜬 적이 없었다**. 배포가 30일에 한 번보다
            #    잦으면 카운터가 절대 안 찬다. 실측: organizer_settlements 0행.
            "schedule": crontab(day_of_month=1, hour=5, minute=0),  # 매월 1일 05:00 KST
        },
        "monthly-settlement-generate": {
            "task": "app.tasks.settlement_generate.generate_settlements",
            # 🔴 위와 같은 이유. 태스크 자체는 "지난 캘린더월" 경계를 쓰므로 1일에 돌면 된다
            #    (`now.replace(day=1)` → [지난달 1일, 이번달 1일) — UTC/KST 어느 쪽이어도 동일).
            "schedule": crontab(day_of_month=1, hour=4, minute=30),  # 매월 1일 04:30 KST
        },
        "gdpr-cleanup": {
            "task": "app.tasks.gdpr_cleanup.process_pending_deletions",
            "schedule": crontab(hour=3, minute=0),  # 매일 03:00 KST
        },
        "dlq-monitor": {
            "task": "app.tasks.dlq_monitor.monitor_dlq",
            "schedule": 300.0,  # Every 5 minutes
        },
        "daily-image-cleanup": {
            "task": "app.tasks.image_processing.cleanup_orphaned_images",
            # 🔴 간격형 금지 — 위 daily-settlement-reconciliation 주석 참조.
            "schedule": crontab(hour=4, minute=0),  # 매일 04:00 KST
        },
        "daily-audit-retention": {
            "task": "app.tasks.audit_retention.prune_audit_logs",
            "schedule": crontab(hour=2, minute=30),  # 매일 02:30 KST
        },
        "daily-backup": {
            "task": "app.tasks.backup_task.auto_backup",
            "schedule": crontab(hour=0, minute=0),  # 매일 00:00 KST
        },
        "beat-heartbeat": {
            "task": "app.tasks.ops_health.beat_heartbeat",
            "schedule": 60.0,  # Every minute
        },
        "orchestrate-event-opens": {
            "task": "app.tasks.event_open_orchestrator.orchestrate_event_opens",
            "schedule": 60.0,  # Every minute — watches upcoming event opens
        },
        # P2-12: ETL 집계 — 매일 새벽 3시 30분 KST
        # (gdpr-cleanup 이 3:00 이라 30분 띄운다 — 원래 둘 다 18:00 로 같은 시각이었다.)
        "daily-etl-aggregation": {
            "task": "app.tasks.etl_aggregation.daily_etl_aggregation",
            "schedule": crontab(hour=3, minute=30),  # 매일 03:30 KST
        },
        # ── 🔴 weekly-curation-push — 대회 종료까지 비활성화 (2026-08-03 대표 지시) ──
        #
        # 무슨 일이 있었나: 2026-08-03(월) 00:00 KST 에 **실제로 발송됐다**(7건).
        # 받은 사람에 발주처 계정(bccard@·hankyung@)이 포함됐고, 내용은
        # "이번 주 맞춤 추천 — BC카드·한경 제48회 KLPGA 챔피언십" 이었다.
        # 🔴 **자기 행사를 자기에게 추천**한 것이다. 지금 행사가 KLPGA 하나뿐이라
        #    추천할 대상이 없다. (푸시 구독 0건이라 폰에는 안 갔고, DB 알림함 기록만
        #    생겨 대표 지시로 7건 삭제했다.)
        #
        # 원인 둘:
        #   ① 주석은 "월요일 09:00 KST" 인데 `hour=0` 이라 **00:00 KST** 에 떴다
        #      (`conf.timezone="Asia/Seoul"` — crontab 은 KST 로 해석된다)
        #   ② 🔴 야간 가드가 **배선되지 않았다**. `compliance.is_night_window` 는 존재하지만
        #      부르는 곳이 `compliance.py:170` 하나뿐이고 푸시 경로는 안 탄다(실측).
        #      21~08시 광고성 발송은 국내 규제 대상이다.
        #
        # 복구 조건 (대회 후):
        #   · 추천할 행사가 2개 이상일 것
        #   · 🔴 `is_night_window` 를 푸시 경로에 배선할 것 — 이게 근본 원인이다
        #   · 시각은 낮으로 (주석 의도대로 09:00 KST = `crontab(hour=9, ...)`)
        #
        # "weekly-curation-push": {
        #     "task": "app.tasks.weekly_curation.push_weekly_curation",
        #     "schedule": crontab(hour=9, minute=0, day_of_week=1),  # 매주 월 09:00 KST
        # },
        # P6: Event-Open 알림 3단계 (D-30min / D-5min / LIVE)
        "check-event-open-alerts": {
            "task": "app.tasks.event_open_scheduler.check_event_open_alerts",
            "schedule": 300.0,  # Every 5 minutes
        },
        # #20: 미발송 알림(당첨/결제기한/대기자승격/환불완료) 주기 발송
        "send-pending-notifications": {
            "task": "app.tasks.notifications.send_pending_notifications",
            "schedule": 60.0,  # Every minute
        },
        # #18: ALLOCATING/COMPUTING 에 고착된 배분 복구 (acks_late 재개 불가 보완)
        "recover-stuck-allocations": {
            "task": "app.tasks.allocation.recover_stuck_allocations",
            "schedule": 300.0,  # Every 5 minutes
        },
        # F1 §3.2: 종료 allpass(전일권) ACTIVE 티켓 → 입장분 USED / 미입장분 EXPIRED (멱등 스윕)
        "expire-allpass-tickets": {
            "task": "app.tasks.expire_allpass.expire_allpass_tickets",
            "schedule": 600.0,  # Every 10 minutes — 종료 후 최대 10분 내 USED/EXPIRED 확정
        },
        # ── 레벨2 스코프A: 주최자 대기열 구매제안 만료 리퍼(go reaper 이관) ──────────
        "waitlist-reap-expired-offers": {
            "task": "app.tasks.waitlist_offer_reaper.reap_expired_offers",
            "schedule": 300.0,  # Every 5 minutes — offered && expires_at<now → expired
        },
        # ── 레벨2 영역C: 조직자 메시징 dispatch 5종 (go infra/cron 흡수) ──────────
        # (crontab 시각은 UTC 해석 — 기존 KST 주석 관례와 동일)
        "messaging-dispatch-messages": {
            "task": "app.tasks.messaging_dispatch.dispatch_messages",
            "schedule": 60.0,  # 1분 — queued 단체공지 드레인
        },
        "messaging-dispatch-campaigns": {
            "task": "app.tasks.messaging_dispatch.dispatch_campaigns",
            "schedule": 60.0,  # 1분 — 광고성 캠페인 드레인
        },
        "messaging-reconcile-deliveries": {
            "task": "app.tasks.messaging_dispatch.reconcile_deliveries",
            "schedule": 300.0,  # 5분 — 고아 sending 스윕 + 부모 재큐잉
        },
        "messaging-consent-reconfirm": {
            "task": "app.tasks.messaging_dispatch.consent_reconfirm",
            "schedule": crontab(hour=2, minute=10),  # 매일 02:10 KST — 2년 동의 재확인 **표식만**(발송 아님)
        },
        "messaging-reminders": {
            "task": "app.tasks.messaging_dispatch.reminders",
            # 🔴 이 항목은 **일부러 낮에 둔다**. 나머지 배치를 KST 야간으로 옮길 때
            #    같이 옮기면 D-7/D-1/당일 리마인더가 **자정에 발송**된다.
            #    옛 주석은 "매일 00:00 KST" 였는데, `conf.timezone="Asia/Seoul"` 이라
            #    실제로는 15:00 KST 에 떠 왔다 — **지금 동작이 맞고 주석이 틀렸다.**
            #    ⚠️ 발송 경로에 시각 가드가 배선돼 있지 않다(`is_night_window` 는
            #       compliance.py:170 한 곳에서만 쓰인다). 스케줄 시각이 곧 발송 시각이다.
            "schedule": crontab(hour=15, minute=0),  # 매일 15:00 KST — D-7/D-1/당일 리마인더
        },
    },
)


# ── Worker observability: Sentry + JSON logging (#29) ───────────────────────
# FastAPI lifespan (main.py) wires Sentry/JSON logging for the API process only.
# Celery workers never run that lifespan, so background payment/lottery errors
# previously reached neither Sentry nor the JSON log-based CloudWatch alarms.
# These signals replicate that wiring inside every worker process.


@celery_setup_logging.connect
def _configure_celery_logging(**_kwargs):
    """Use our JSONFormatter (prod) instead of Celery's default text logging.

    Returning from this handler suppresses Celery's own logging setup, so our
    handlers are not clobbered — JSON lines now match the CloudWatch metric
    filters (``$.level = "ERROR" && $.message = "*payment*"``).
    """
    try:
        from app.core.logging_config import setup_logging

        setup_logging()
    except Exception:  # noqa: BLE001
        # Never let logging setup crash a worker; fall back to root logging.
        logging.basicConfig(level=logging.INFO)
        logger.warning("Celery setup_logging failed — using basicConfig", exc_info=True)


def _init_worker_sentry():
    """Initialize Sentry with the Celery integration inside a worker process."""
    if not settings.SENTRY_DSN:
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.celery import CeleryIntegration

        if sentry_sdk.Hub.current.client is not None:
            return  # already initialized in this process

        sentry_sdk.init(
            dsn=settings.SENTRY_DSN,
            traces_sample_rate=settings.SENTRY_TRACES_SAMPLE_RATE,
            environment=settings.SENTRY_ENVIRONMENT or settings.ENVIRONMENT,
            release=f"pickket-worker@{settings.VERSION}",
            send_default_pii=False,
            integrations=[
                CeleryIntegration(
                    monitor_beat_tasks=False,
                    propagate_traces=True,
                ),
            ],
        )
        logger.info(
            "Celery worker Sentry initialized (env=%s)",
            settings.SENTRY_ENVIRONMENT or settings.ENVIRONMENT,
        )
    except Exception:  # noqa: BLE001
        logger.warning("Celery worker Sentry init failed", exc_info=True)


@worker_process_init.connect
def _on_worker_process_init(**_kwargs):
    """Per-forked-process init: Sentry must be initialized after fork."""
    _init_worker_sentry()


# ── Dead Letter Queue: route permanently failed tasks to DLQ ────────────────


@task_failure.connect
def on_task_failure(
    sender=None,
    task_id=None,
    exception=None,
    args=None,
    kwargs=None,
    traceback=None,
    einfo=None,
    **kw,
):
    """When a task exhausts all retries, publish a DLQ record for post-mortem."""
    task = sender
    if task is None:
        return

    # Only route to DLQ if retries are exhausted
    max_retries = getattr(task, "max_retries", None)
    request = getattr(task, "request", None)
    current_retries = getattr(request, "retries", 0) if request else 0

    if max_retries is not None and current_retries < max_retries:
        # Still has retries left; this failure will be retried
        return

    task_name = getattr(task, "name", str(sender))
    logger.error(
        "Task %s[%s] permanently failed after %d retries; routing to DLQ. Error: %s",
        task_name,
        task_id,
        current_retries,
        exception,
    )

    # 운영 알림 발송
    try:
        from app.core.alerting import send_ops_alert_sync

        send_ops_alert_sync(
            "warning",
            f"Celery 태스크 실패: {task_name}",
            {
                "task_id": str(task_id),
                "error": str(exception)[:500],
                "retries": current_retries,
            },
        )
    except Exception:
        logger.debug("Failed to send ops alert for task %s", task_name, exc_info=True)

    try:
        celery_app.send_task(
            "dlq.dead_letter",
            queue="dlq",
            kwargs={
                "original_task": task_name,
                "original_task_id": task_id,
                "original_args": list(args) if args else [],
                "original_kwargs": dict(kwargs) if kwargs else {},
                "exception": str(exception),
                "traceback": str(einfo) if einfo else "",
            },
        )
    except Exception:
        logger.error(
            "Failed to publish DLQ record for task %s[%s]",
            task_name,
            task_id,
            exc_info=True,
        )
