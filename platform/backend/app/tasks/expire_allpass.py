"""Celery task: allpass(전일권) 티켓 종료 → USED/EXPIRED 전환 (F1 후속, 계약서 §3.2).

배경
====
F1(CHECKIN-STATE-CONTRACT-F1 §3.2)에서 allpass(전일권) 티켓은 입장해도
`status=ACTIVE` 를 유지한다 — 대회 기간 동안 매일 재입장해야 하기 때문이다.
single/daypass 는 입장 시점에 즉시 USED 로 소진되지만, allpass 는 "언제 소진되었나"의
자연스러운 경계가 **이벤트 종료 시점**이다. admission_service.admit() 은 그 시점의
전환을 이 주기 태스크에 위임한다("allpass → ACTIVE 유지(종료 후 lazy/cron 으로 전환)").

미입장 정책 (확정: 미입장 = EXPIRED)
====================================
종료 시점 allpass ACTIVE 티켓을 **입장 이력으로 분기**한다:
  - `first_checked_in_at IS NOT NULL` (한 번이라도 입장) → `USED`  (정상 소진)
  - `first_checked_in_at IS NULL`     (한 번도 미입장) → `EXPIRED`(미사용 만료)
이전에는 모든 ACTIVE 를 USED 로 뭉갰으나, 미입장분까지 USED 로 표기하면
"사용 완료"와 "미사용 만료"가 구분되지 않아 정산/통계·환불정책 판단이 어긋난다.

대상
====
아래 3조건을 모두 만족하는 allpass 티켓을 위 분기로 전환:
  1. 이벤트 `events.admission_mode = 'allpass'`
  2. 티켓 `status = 'active'`
  3. 이벤트 종료: `coalesce(event_date_end, event_date) < now`

  * single/daypass·비-allpass 이벤트 티켓은 admission_mode 필터로 무영향.
  * 미종료 allpass 이벤트 티켓은 종료판정으로 무영향.
  * 이미 USED/PENDING/CANCELLED/EXPIRED/TRANSFERRED 티켓은 status 필터로 무영향.

KST 종료판정 (UTC ::date 캐스트 금지)
=====================================
`event_date` / `event_date_end` 는 timestamptz(UTC 저장) **인스턴트**다. 종료판정은
인스턴트 비교(`< now`)로 수행한다 — 인스턴트 비교는 타임존 무관하게 정확하다.
`::date` 캐스트(F1 의 06시 게이트 전날버그 원인)를 **쓰지 않는다**. 종료 경계는
event_date_end 인스턴트 그 자체이며, 이는 주최자가 KST 벽시계로 지정한 종료시각이
timestamptz 로 저장된 것이므로 KST 기준 종료판정과 일치한다.

멱등·배치·트랜잭션 경계 증명
============================
- "동시 2회 실행하면?": 두 UPDATE(USED/EXPIRED) 모두 `status='active'` 를 조건에 포함하고,
  각각 `first_checked_in_at IS NOT NULL`(USED)·`IS NULL`(EXPIRED) 로 상호배타 분기한다.
  첫 실행이 status 를 'used'/'expired' 로 바꾸면 두 번째 실행의 WHERE 가 그 행을 더
  이상 매칭하지 않는다(교집합 0). 두 분기는 서로소(입장 이력 유무)라 한 티켓이 양쪽에
  잡히지 않는다. 청크 단위 UPDATE 는 각각 원자적이므로 이중 전환 불가. 재실행은 멱등
  (다시 돌려도 0건).
- "외부호출 후 crash 하면?": 이 태스크는 **순수 DB write** 만 한다(외부 API·웹훅 없음).
  청크마다 COMMIT 하며, 각 청크는 자체 트랜잭션 경계에서 원자적으로 반영된다. 도중
  crash 해도 이미 커밋된 청크는 유효(USED 확정), 미커밋 청크는 다음 실행에서 재처리.
- 대량 안전: id 기준 청크(기본 2000) 로 잘라 UPDATE → 장기 락·거대 트랜잭션 방지.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from celery import shared_task
from sqlalchemy import func, select, update

from app.core.database import SyncSession
from app.models.event import Event
from app.models.ticket import Ticket, TicketStatus

logger = logging.getLogger(__name__)

# 청크 크기 — 한 UPDATE 가 잠그는 최대 행 수. 대량 종료 이벤트에서 장기 락·거대 txn 방지.
_CHUNK_SIZE = 2000
# 방어적 청크 반복 상한 — 무한루프 가드(정상적으로는 status 필터가 수렴을 보장).
_MAX_CHUNKS = 10_000


def _transition_chunked(
    session,
    ended_allpass_events,
    *,
    checked_in: bool,
    target: TicketStatus,
    chunk_size: int,
) -> int:
    """종료 allpass 의 ACTIVE 티켓 중 입장이력 분기 한쪽을 `target` 으로 청크 전환.

    - checked_in=True  → `first_checked_in_at IS NOT NULL` 부분집합 → USED.
    - checked_in=False → `first_checked_in_at IS NULL`     부분집합 → EXPIRED.
    청크 단위(id 기준)로 UPDATE 하며 각 청크를 개별 COMMIT 한다. 멱등:
    status='active' + first_checked_in_at 분기 조건이 이미 처리된 행을 재매칭하지
    않으므로 재실행 시 0건. 두 분기는 서로소라 한 티켓이 양쪽에 잡히지 않는다.
    """
    checkin_pred = (
        Ticket.first_checked_in_at.is_not(None)
        if checked_in
        else Ticket.first_checked_in_at.is_(None)
    )

    total = 0
    for _ in range(_MAX_CHUNKS):
        # 이번 청크에서 전환할 티켓 id 를 먼저 확정(FOR UPDATE SKIP LOCKED 로 동시성 안전).
        # sqlite(테스트)는 SKIP LOCKED 를 무시하나 단일 커넥션이라 무해.
        candidate_ids = (
            session.execute(
                select(Ticket.id)
                .where(
                    Ticket.status == TicketStatus.ACTIVE,
                    Ticket.event_id.in_(ended_allpass_events),
                    Ticket.deleted_at.is_(None),
                    checkin_pred,
                )
                .limit(chunk_size)
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )
        if not candidate_ids:
            break

        result = session.execute(
            update(Ticket)
            .where(
                Ticket.id.in_(candidate_ids),
                # 재확인: 확정~UPDATE 사이 상태가 바뀌었을 수 있으므로 active 재검(멱등 가드).
                Ticket.status == TicketStatus.ACTIVE,
                # 입장이력 분기도 재확인 — 확정~UPDATE 사이 최초입장 기록이 붙는 경합 방지.
                checkin_pred,
            )
            .values(status=target)
        )
        session.commit()
        affected = result.rowcount or 0
        total += affected
        logger.info(
            "expire_allpass: %s 청크 전환 %d건 (누적 %d)", target.value, affected, total
        )

        # 확정 candidate 보다 적게 UPDATE 됐거나 청크가 덜 찼으면 마지막 청크.
        if len(candidate_ids) < chunk_size:
            break

    return total


def _expire_allpass(session, now: datetime, chunk_size: int) -> dict[str, int]:
    """종료된 allpass 이벤트의 ACTIVE 티켓을 입장이력 분기로 전환.

    입장분(first_checked_in_at IS NOT NULL) → USED, 미입장분(NULL) → EXPIRED.
    반환: {"used": n, "expired": m, "total": n+m}.
    """
    # 종료된 allpass 이벤트 id 집합 (서브쿼리). coalesce 로 event_date_end 없으면
    # event_date 사용. `< now` 인스턴트 비교 — ::date 캐스트 없음(KST-safe).
    ended_allpass_events = (
        select(Event.id)
        .where(
            Event.admission_mode == "allpass",
            func.coalesce(Event.event_date_end, Event.event_date) < now,
        )
        .scalar_subquery()
    )

    used = _transition_chunked(
        session, ended_allpass_events,
        checked_in=True, target=TicketStatus.USED, chunk_size=chunk_size,
    )
    expired = _transition_chunked(
        session, ended_allpass_events,
        checked_in=False, target=TicketStatus.EXPIRED, chunk_size=chunk_size,
    )
    return {"used": used, "expired": expired, "total": used + expired}


@shared_task(
    name="app.tasks.expire_allpass.expire_allpass_tickets",
    bind=True,
    queue="analytics",
    soft_time_limit=300,
    time_limit=330,
)
def expire_allpass_tickets(self, chunk_size: int = _CHUNK_SIZE) -> dict:
    """종료된 allpass 이벤트의 ACTIVE 티켓을 USED/EXPIRED 로 일괄 전환 (F1 §3.2 후속).

    입장분(first_checked_in_at 有) → USED, 미입장분(無) → EXPIRED.
    beat 로 주기 실행(기본 10분). 멱등·배치·순수 DB write.
    반환: {"used": n, "expired": m, "total": n+m, "ran_at": ISO8601}.
    ("expired" 는 이제 미입장 만료분만 — 전체는 "total").
    """
    now = datetime.now(timezone.utc)
    size = chunk_size if chunk_size and chunk_size > 0 else _CHUNK_SIZE

    with SyncSession() as session:
        counts = _expire_allpass(session, now, size)

    logger.info(
        "expire_allpass_tickets: USED %d · EXPIRED %d (총 %d, 기준시각 %s)",
        counts["used"], counts["expired"], counts["total"], now.isoformat(),
    )
    return {**counts, "ran_at": now.isoformat()}
