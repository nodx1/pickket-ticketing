"""자동 백업 Celery 태스크."""

import importlib.util
import logging
import time
from pathlib import Path

from celery import shared_task

from app.core.ops_health import record_backup_failure_sync, record_backup_success_sync
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL

logger = logging.getLogger(__name__)


def _load_backup_callable():
    try:
        from scripts.backup import do_backup

        return do_backup
    except ModuleNotFoundError:
        backup_path = Path(__file__).resolve().parents[2] / "scripts" / "backup.py"
        spec = importlib.util.spec_from_file_location("pickket_runtime_backup", backup_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Unable to load backup script: {backup_path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.do_backup


@shared_task(
    name="app.tasks.backup_task.auto_backup",
    bind=True,
    max_retries=2,
    acks_late=True,
)
def auto_backup(self):
    """매일 자정 자동 백업.

    scripts/backup.py의 do_backup()을 호출.
    실패 시 운영 알림 발송.
    """
    _task_name = "auto_backup"
    _start = time.perf_counter()

    try:
        do_backup = _load_backup_callable()
        result = do_backup()
        record_backup_success_sync(result)
        _duration = time.perf_counter() - _start

        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.warning("backup metrics recording failed", exc_info=True)

        logger.info("Auto backup completed successfully in %.1fs", _duration)
        return {"success": True, "duration": _duration}

    except Exception as exc:
        record_backup_failure_sync(str(exc))
        _duration = time.perf_counter() - _start

        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.warning("backup failure metrics recording failed", exc_info=True)

        # 운영 알림 발송
        try:
            from app.core.alerting import send_ops_alert_sync
            send_ops_alert_sync("critical", "DB 백업 실패", {
                "error": str(exc)[:200],
                "retry": f"{self.request.retries}/{self.max_retries}",
            }, mention=True)
        except Exception:
            logger.warning("backup ops alert delivery failed", exc_info=True)

        logger.error("Auto backup failed: %s", exc)
        raise self.retry(exc=exc, countdown=60 * (self.request.retries + 1))
