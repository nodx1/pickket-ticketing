"""beat 스케줄 구조 가드 — 간격형(float) 일일·월간 작업 금지.

## 🔴 왜 필요한가 (2026-08-02 실사고)

celery beat 의 `"schedule": 86400.0` 은 **"하루에 한 번"이 아니다.** `beat 가 뜬 뒤 24시간`
이다. 24시간 안에 beat 가 재시작되면 카운터가 0 으로 리셋되어 **영원히 안 온다.**

실측 결과:

    daily-settlement-reconciliation   86400.0     07-24~07-30 매일 돌다가
                                                  07-31 celery 재배포 후 daily 실행 **0회**
    monthly-settlement-generate     2592000.0     🔴 **한 번도 실행된 적 없음**
    monthly-tier-recalculation      2592000.0     🔴 (prod organizer_settlements 0행)

우리는 하루에 여러 번 배포한다. 30일 간격형은 **구조적으로 절대 안 뜬다.**
`monthly-settlement-generate` 는 주최자 정산을 만드는 유일한 경로이고(수동 생성
엔드포인트 없음 — admin_settlements.py 에 generate 0개), 그것이 한 번도 안 돌았다.

⟹ **주기가 1시간 이상이면 `crontab`(시각 고정)을 쓴다.** 재시작에 영향받지 않는다.

⚠️ 단주기(초·분 단위)는 간격형이 자연스럽다 — 리셋돼도 곧 다시 온다. 그래서 임계값을
   두고 그 이상만 막는다.
"""
from __future__ import annotations

import pytest
from celery.schedules import crontab, schedule as interval_schedule

from app.core.celery_app import celery_app

# 1시간 이상이면 시각 고정이어야 한다. 재배포 간격이 이보다 짧을 수 있기 때문.
MAX_INTERVAL_SECONDS = 3600


def _entries() -> dict:
    return dict(celery_app.conf.beat_schedule or {})


def test_beat_schedule_is_not_empty() -> None:
    """가드가 빈 딕트를 훑고 통과하는 헛통과를 막는다."""
    entries = _entries()
    assert len(entries) >= 20, f"beat_schedule 항목이 {len(entries)}개뿐 — 가드가 무의미하다"


def test_no_long_interval_schedules() -> None:
    """1시간 이상 주기는 crontab 이어야 한다 — 간격형은 재시작마다 리셋된다."""
    offenders = []
    for name, entry in _entries().items():
        sched = entry.get("schedule")
        if isinstance(sched, crontab):
            continue
        seconds = None
        if isinstance(sched, (int, float)):
            seconds = float(sched)
        elif isinstance(sched, interval_schedule):
            seconds = sched.run_every.total_seconds()
        if seconds is not None and seconds >= MAX_INTERVAL_SECONDS:
            offenders.append((name, seconds))

    assert not offenders, (
        "🔴 간격형 스케줄이 1시간 이상이다 — beat 재시작마다 카운터가 리셋되어 "
        "영원히 안 뜰 수 있다. crontab(시각 고정)으로 바꿀 것:\n"
        + "\n".join(f"  {n}: {s}s" for n, s in offenders)
    )


@pytest.mark.parametrize(
    "name",
    [
        "daily-settlement-reconciliation",
        "daily-image-cleanup",
        "monthly-settlement-generate",
        "monthly-tier-recalculation",
        "auto-void-stale-authorizations",
    ],
)
def test_previously_interval_entries_are_now_crontab(name: str) -> None:
    """실제로 물렸던 5건이 crontab 으로 남아 있는지 이름으로 못박는다.

    위 일반 가드만 있으면 항목이 **삭제**돼도 통과한다. 이름을 박아 그것도 막는다.
    """
    entry = _entries().get(name)
    assert entry is not None, f"{name} 항목이 사라졌다"
    assert isinstance(entry["schedule"], crontab), (
        f"{name} 이 다시 간격형으로 돌아갔다: {entry['schedule']!r}"
    )


def test_monthly_settlement_runs_on_first_of_month() -> None:
    """정산은 '지난 캘린더월' 경계를 쓰므로 **1일**에 떠야 한다.

    다른 날에 뜨면 기간 산정(`now.replace(day=1)`)과 어긋나지는 않지만,
    한 달 내내 아무 때나 뜨는 것은 의도가 아니다.
    """
    sched = _entries()["monthly-settlement-generate"]["schedule"]
    assert isinstance(sched, crontab)
    assert sched.day_of_month == {1}, f"매월 1일이 아니다: {sched.day_of_month}"


# ── 🔴 시간대 — crontab 은 UTC 가 아니라 KST 로 해석된다 (2026-08-02 실사고) ────
#
# `celery_app.conf.timezone = "Asia/Seoul"` 이다. 그런데 기존 주석이 전부 UTC 기준으로
# 쓰여 있었고("매일 01:30 KST (16:30 UTC)"), 나도 그 주석을 근거로 삼아 같은 실수를
# 이어받았다. 결과: crontab 13건 중 **11건이 낮에 떴다.**
#
#     daily-backup 14:59 · gdpr-cleanup 17:59 · daily-settlement-reconciliation 16:49 …
#     🔴 대회 당일(8/20) 오후 4시 50분에 대사가 도는 상태였다
#
# 그리고 실제로 사고가 났다 — `weekly-curation-push` 가 2026-08-03(월) **00:00 KST**
# 에 발송돼 발주처 계정(bccard@·hankyung@)에 "이번 주 맞춤 추천: KLPGA" 가 갔다.
# 자기 행사를 자기에게 추천한 것이다(7건, 대표 지시로 삭제).
#
# ⚠️ **기계적으로 9시간 당기면 안 된다.** 발송 작업은 낮에 도는 게 맞다 —
#    `messaging-reminders` 를 같이 옮겼으면 리마인더가 자정에 나갔을 것이다.
#    발송 경로에 시각 가드가 **배선돼 있지 않다**(`is_night_window` 는
#    compliance.py:170 한 곳에서만 쓰인다). 스케줄 시각이 곧 발송 시각이다.
#
# ⟹ 항목마다 **어느 부류인지 선언**하게 한다. 새 항목을 추가하면 분류를 강제당한다.

_NIGHT_BATCH = {  # 트래픽 적은 KST 야간에 도는 정비·집계 작업
    "daily-sold-count-reconciliation",
    "daily-settlement-reconciliation",
    "messaging-consent-reconfirm",   # 표식만 남김 — 발송 아님
    "daily-audit-retention",
    "gdpr-cleanup",
    "daily-etl-aggregation",
    "daily-image-cleanup",
    "monthly-settlement-generate",
    "monthly-tier-recalculation",
    "daily-backup",
    "refresh-tenure-scores",  # 과업 WP2 — 누적 시간 점수 집계(발송 아님)
}
_DAYTIME_SEND = {  # 🔴 손님에게 나가는 것 — 야간 금지
    "messaging-reminders",
}
_HOURLY = {  # 매시 반복 — 시각 부류 판정 대상 아님
    "auto-void-stale-authorizations",
}
_NIGHT_START, _NIGHT_END = 22, 8   # 22:00~08:00 KST 를 야간으로 본다


def _crontab_entries() -> dict:
    from celery.schedules import crontab
    return {
        k: v["schedule"]
        for k, v in _entries().items()
        if isinstance(v.get("schedule"), crontab)
    }


def test_every_crontab_entry_is_classified() -> None:
    """새 crontab 항목은 야간배치·주간발송·매시 중 하나로 분류돼야 한다.

    분류를 강제하지 않으면 "일단 넣고 시각은 나중에" 가 되고, 그것이 이번 사고였다.
    """
    known = _NIGHT_BATCH | _DAYTIME_SEND | _HOURLY
    unknown = set(_crontab_entries()) - known
    assert not unknown, (
        f"분류되지 않은 crontab 항목: {sorted(unknown)}\n"
        "야간배치(_NIGHT_BATCH) / 주간발송(_DAYTIME_SEND) / 매시(_HOURLY) 중 하나에 넣을 것.\n"
        "🔴 conf.timezone='Asia/Seoul' 이라 crontab 의 hour 는 **KST** 다."
    )


def test_night_batch_runs_at_night_kst() -> None:
    """정비·집계는 KST 야간에 돈다 — 대회 당일 낮에 대사가 돌면 안 된다."""
    offenders = []
    for name, sched in _crontab_entries().items():
        if name not in _NIGHT_BATCH:
            continue
        for h in sorted(sched.hour):
            if _NIGHT_END <= h < _NIGHT_START:
                offenders.append(f"{name}: {h:02d}시 KST")
    assert not offenders, (
        "🔴 야간 배치가 낮에 뜬다 (conf.timezone='Asia/Seoul' — hour 는 KST):\n  "
        + "\n  ".join(offenders)
    )


def test_send_tasks_never_run_at_night_kst() -> None:
    """🔴 손님에게 나가는 발송은 야간에 돌면 안 된다.

    21~08시 광고성 발송은 국내 규제 대상이고, 발송 경로에 시각 가드가
    배선돼 있지 않아 **스케줄 시각이 곧 발송 시각**이다.
    """
    offenders = []
    for name, sched in _crontab_entries().items():
        if name not in _DAYTIME_SEND:
            continue
        for h in sorted(sched.hour):
            if h >= _NIGHT_START or h < _NIGHT_END:
                offenders.append(f"{name}: {h:02d}시 KST")
    assert not offenders, (
        "🔴 발송 작업이 야간에 뜬다 — 손님 폰이 밤에 울린다:\n  " + "\n  ".join(offenders)
    )


def test_weekly_curation_push_stays_disabled_until_after_event() -> None:
    """🔴 주간 큐레이션은 대회 종료까지 비활성이다 (2026-08-03 대표 지시).

    행사가 KLPGA 하나뿐이라 **자기 행사를 자기에게 추천**한다.
    실제로 08-03(월) 00:00 KST 에 발주처 계정으로 나갔다.

    되살릴 때 함께 할 것: ① 추천 대상 2개 이상 ② `is_night_window` 를 푸시 경로에
    배선 ③ 시각을 낮으로(09:00 KST).
    """
    assert "weekly-curation-push" not in _entries(), (
        "weekly-curation-push 가 다시 켜졌다 — 되살리기 전에 야간가드 배선부터 할 것"
    )
