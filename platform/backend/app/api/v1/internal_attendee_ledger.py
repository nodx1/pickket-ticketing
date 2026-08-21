"""레벨2 컷오버 W5-ATTENDEE — go 참석자 부속 원장 6종의 internal API.

go 가 자기 DB 에 직접 SQL 로 읽고 쓰던 부속 원장(설문 문항·초대권·발송큐·좌석알림·
체크인 명단/로그)을 v2 정본으로 옮기고, 그 접근 경로를 서비스 간 internal API 로 제공한다.
인증은 `internal_commerce._internal_auth`(HMAC 서명 + dev/staging 서비스토큰 폴백) 재사용.

라우트 (실경로에는 `/api/v1/internal` 접두):

  ── 예매 설문 문항 ──
  GET    /events/{event_id}/questions              문항 목록(주최자/체크아웃 공용)
  POST   /events/{event_id}/questions              문항 생성
  PATCH  /events/{event_id}/questions/{qid}        문항 수정
  DELETE /events/{event_id}/questions/{qid}        문항 보관(soft delete)
  PUT    /events/{event_id}/questions/order        순서 변경

  ── 초대권 ──
  GET    /events/{event_id}/invitations            추적 목록 + 상태 집계 + 유효 발급 수
  POST   /events/{event_id}/invitations/reserve    발권 전 원자 예약(dedup 지점)
  POST   /invitations/{id}/issued                  발권 성공 반영 + 발송 큐 적재(원자)
  POST   /invitations/{id}/failed                  발권 실패 반영
  POST   /invitations/{id}/revoke                  회수(nonce++ · 대기 큐 제거)
  POST   /invitations/{id}/resend                  재발송(큐 재적재 + send_epoch++)
  POST   /invitations/by-ticket-number/{tn}/mark   열람/입장 훅

  ── 초대권 발송 큐(드레인 워커 전용) ──
  POST   /invitation-dispatch/claim                배치 클레임(리스)
  POST   /invitation-dispatch/requeue              발송 불가분 재큐잉
  POST   /invitation-dispatch/complete             발송 결과 반영

  ── 좌석 알림(찜) ──
  GET    /events/{event_id}/seat-watches           내 찜 목록
  POST   /events/{event_id}/seat-watches           찜 등록/갱신(upsert)
  DELETE /events/{event_id}/seat-watches           찜 해제
  GET    /seat-watches/pending                     미발송 후보(cron)
  POST   /seat-watches/{id}/claim                  발송 선점(조건부)
  POST   /seat-watches/{id}/release                선점 해제(발송 실패 복구)

  ── 현장 체크인 ──
  GET    /events/{event_id}/check-in-lists         명단 목록
  GET    /events/{event_id}/check-in-lists/{id}    명단 단건(체크인 게이트 검증용)
  POST   /events/{event_id}/check-in-lists         명단 생성
  PATCH  /events/{event_id}/check-in-lists/{id}    명단 수정
  DELETE /events/{event_id}/check-in-lists/{id}    명단 삭제
  GET    /events/{event_id}/check-in-logs          로그 목록(이벤트/티켓/명단 스코프)
  POST   /events/{event_id}/check-in-logs          로그 기록(멱등)
  DELETE /events/{event_id}/check-in-logs          로그 삭제(입장취소 원복)

── 테넌트 경계 ──
이벤트 스코프 라우트는 전부 `_event_owner_guard` 로 `events.organizer_id == resolve(organizer_ref)`
를 강제한다. 불일치/미존재는 **404 로 일반화**해 타 테넌트 이벤트의 존재가 새지 않게 한다.
예외 3가지(의도된 것):
  · `GET /events/{id}/questions` 의 organizer_ref 는 **선택**이다. 문항 정의는 이미
    소비자 공개 응답(`EventResponse.questions`)으로 노출되는 공개 데이터이고, go 의 공개
    체크아웃 상세 빌더가 계정 없이 읽어야 한다. 넘기면 소유 일치를 강제한다.
  · 좌석 찜은 소비자(비로그인 포함) 데이터라 organizer 경계가 없다 — 소유축은
    `user_id`(v2 회원) 또는 `session_id`(게스트 쿠키)이며 **둘 중 하나가 반드시 필요**하다.
  · 드레인/cron 전용 라우트는 호스트 워커 전용이라 이벤트 스코프가 없다(서비스 인증만).

── 멱등성 / 동시성 (설계 증명) ──
· 초대권 예약: "동시 2회 실행하면?" → UNIQUE(event_id, phone_normalized, **seq**) 가
  두 번째를 튕긴다. 잡아서 기존 행을 `created=false` 로 재생하고, go 는 `created=true`
  일 때만 발권(v2 주문 생성)한다 → **같은 (번호, 순번) 에 2장은 구조적으로 불가**.
  ⚠️ 2026-07-30 변경: 종전엔 `UNIQUE(event_id, phone_normalized)` 라 "한 번호에 1장" 이었다.
     대회 요건(1인 최대 5장)으로 **순번을 추가**했다 — 제약을 지우면 동시성 방어까지
     사라지므로, 락 역할을 유지하며 한도만 1 → `INVITATION_MAX_PER_PHONE` 로 열었다.
     상한 초과는 **409 `INVITATION_LIMIT`**. 호출자는 seq 를 1부터 올려가며 시도하고
     그 409 를 종료 조건으로 쓴다(상한을 호출자가 세면 동시 요청에 뚫린다).
· 발송 큐 클레임: 조건부 UPDATE(`queued` 또는 리스만료 `sending`)로 선점한다. 동시 두
  워커는 같은 행에서 직렬화되고, 진 쪽은 갱신 0행 → 그 행을 받지 못한다.
  "외부호출 후 crash 하면?" → 리스가 만료되면 재클레임되지만 `send_epoch` 는 그대로라
  NCP 멱등키가 **같다** → 알림톡이 두 번 나가지 않는다. 주최자의 명시적 재발송만 epoch 를
  올려 새 키를 만든다.
· 체크인 로그: UNIQUE(ticket_id, attended_date) + 선조회/충돌흡수 → 재시도해도 1행.
  입장 자체의 멱등 정본은 v2 `event_admissions` 이고, 이 로그는 그 사본이다.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date as date_cls
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError,
    OrganizerRef,
    _err,
    _internal_auth,
    _ok,
    _resolve_organizer,
)
from app.core.database import get_db
from app.models.event import Event
from app.models.ticket import Ticket
from app.models.go_attendee_ledger import (
    INVITATION_MAX_PER_PHONE,
    CheckInList,
    CheckInLog,
    EventInvitation,
    EventQuestion,
    InvitationDispatch,
    SeatWatch,
)
from app.models.ticket import Ticket, TicketStatus

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(_internal_auth)])

_MAX_LIST_LIMIT = 500
_MAX_LOG_LIMIT = 20000
_MAX_CLAIM_LIMIT = 500


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dispatch_claim_stale_sql(now: datetime):
    """클레임 가능(= 리스가 죽었다) 판정 — **SQL 쪽**.

    `queued` 이거나, `sending` 인데 리스가 만료됐거나 애초에 없는 행.
    """
    return or_(
        InvitationDispatch.status == "queued",
        (InvitationDispatch.status == "sending")
        & (
            (InvitationDispatch.claim_expires_at.is_(None))
            | (InvitationDispatch.claim_expires_at < now)
        ),
    )


def _dispatch_lease_alive(dispatch, now: datetime) -> bool:
    """리스가 아직 살아 있는가 — 위 SQL 판정의 **파이썬 쌍둥이**.

    🔴 두 판정이 갈라지면 그 틈이 곧 중복 발송이다. 그래서 한 곳에 붙여 두고
    경계까지 맞춘다: SQL 은 `claim_expires_at < now` 를 죽은 것으로 본다
    ⟹ **같음(`== now`)은 살아 있는 쪽**이다. 여기서도 `>= now` 다.

    ⚠️ `claim_expires_at` 이 없으면 **죽은 것**으로 읽는다. 워커가 리스를 안 걸고
       `sending` 만 박아둔 행을 영구 잠금으로 만들지 않기 위해서다(claim 쪽과 동일).
    """
    exp = getattr(dispatch, "claim_expires_at", None)
    if exp is None:
        return False
    if exp.tzinfo is None:
        # SQLite·naive 저장 대비. UTC 로 읽는다(_now() 가 UTC 다).
        exp = exp.replace(tzinfo=timezone.utc)
    return exp >= now


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _ymd(value: date_cls | None) -> str | None:
    return value.isoformat() if value else None


def _parse_ref(organizer_ref: str) -> OrganizerRef:
    """쿼리스트링 organizer_ref(uuid 또는 go account 문자열) → OrganizerRef."""
    try:
        return OrganizerRef(organizer_id=uuid.UUID(organizer_ref))
    except ValueError:
        return OrganizerRef(go_account_id=organizer_ref)


async def _event_owner_guard(
    db: AsyncSession, event_id: uuid.UUID, ref: OrganizerRef
) -> uuid.UUID:
    """`events.organizer_id == resolve(ref)` 일 때만 통과. 반환 = organizer_id.

    불일치/미존재를 모두 404 EVENT_NOT_FOUND 로 **일반화**한다(존재 여부 비노출).
    """
    organizer_id = await _resolve_organizer(db, ref)
    owner = (
        await db.execute(select(Event.organizer_id).where(Event.id == event_id))
    ).scalar_one_or_none()
    if owner is None or owner != organizer_id:
        raise ApiError("EVENT_NOT_FOUND", "event not found", 404, "event_id")
    return organizer_id


# ═════════════════════════════════════════════════════════════════════════════
# 1) 예매 설문 문항 정의
# ═════════════════════════════════════════════════════════════════════════════


class QuestionIn(BaseModel):
    organizer_ref: OrganizerRef
    # go id 승계 — 이미 발권된 티켓의 `answers` 키(=문항 id)를 보존하기 위한 경로.
    question_id: uuid.UUID | None = None
    label: str = Field(..., min_length=1, max_length=2000)
    question_type: str = Field(
        ..., pattern="^(short_text|long_text|single_choice|multiple_choice|checkbox)$"
    )
    is_required: bool = False
    options: list[str] = Field(default_factory=list)
    sort_order: int | None = Field(None, ge=0)


class QuestionPatch(BaseModel):
    organizer_ref: OrganizerRef
    label: str | None = Field(None, min_length=1, max_length=2000)
    question_type: str | None = Field(
        None, pattern="^(short_text|long_text|single_choice|multiple_choice|checkbox)$"
    )
    is_required: bool | None = None
    options: list[str] | None = None


class QuestionOrderIn(BaseModel):
    organizer_ref: OrganizerRef
    ordered_ids: list[uuid.UUID] = Field(..., min_length=1)


def _serialize_question(row: EventQuestion) -> dict:
    return {
        "id": str(row.id),
        "label": row.label,
        "question_type": row.question_type,
        "is_required": bool(row.is_required),
        "options": list(row.options or []),
        "sort_order": int(row.sort_order),
        "archived": row.archived_at is not None,
        "created_at": _iso(row.created_at),
    }


async def _load_questions(
    db: AsyncSession, event_id: uuid.UUID, *, include_archived: bool
) -> list[EventQuestion]:
    stmt = select(EventQuestion).where(EventQuestion.event_id == event_id)
    if not include_archived:
        stmt = stmt.where(EventQuestion.archived_at.is_(None))
    stmt = stmt.order_by(EventQuestion.sort_order.asc(), EventQuestion.created_at.asc())
    return list((await db.execute(stmt)).scalars().all())


async def _refresh_questions_projection(db: AsyncSession, event_id: uuid.UUID) -> None:
    """`events.questions`(JSONB) 투영 갱신.

    소비자 상세(`EventResponse.questions`)는 이미 이 컬럼을 읽는다. 문항 정본이 테이블로
    옮겨졌으므로, **같은 DB·같은 트랜잭션 안에서** 투영을 다시 쓴다(외부호출 없음 →
    "커밋 후 외부호출" 규약과 충돌하지 않고, 정본/투영이 갈라질 창이 없다).
    빈 목록은 NULL 로 수렴시켜 "섹션 없음" 의미를 유지한다(기존 collector 계약과 동일).
    """
    rows = await _load_questions(db, event_id, include_archived=False)
    payload = [
        {
            "label": r.label,
            "type": r.question_type,
            "required": bool(r.is_required),
            "options": list(r.options or []),
        }
        for r in rows
    ]
    await db.execute(
        update(Event).where(Event.id == event_id).values(questions=payload or None)
    )


@router.get("/events/{event_id}/questions")
async def list_questions(
    event_id: uuid.UUID,
    organizer_ref: str | None = Query(
        None, description="주최자 스코프. 생략 시 공개 문항 정의 조회(체크아웃 빌더)"
    ),
    include_archived: bool = Query(
        False, description="보관된 문항 포함 — 응답(answers) 라벨 해석용"
    ),
    db: AsyncSession = Depends(get_db),
):
    try:
        if organizer_ref is not None:
            await _event_owner_guard(db, event_id, _parse_ref(organizer_ref))
        else:
            exists = (
                await db.execute(select(Event.id).where(Event.id == event_id))
            ).scalar_one_or_none()
            if exists is None:
                raise ApiError("EVENT_NOT_FOUND", "event not found", 404, "event_id")
        rows = await _load_questions(db, event_id, include_archived=include_archived)
        return _ok({"questions": [_serialize_question(r) for r in rows]})
    except ApiError as e:
        return _err(e)


@router.post("/events/{event_id}/questions")
async def create_question(
    event_id: uuid.UUID,
    body: QuestionIn,
    db: AsyncSession = Depends(get_db),
):
    try:
        organizer_id = await _event_owner_guard(db, event_id, body.organizer_ref)

        sort_order = body.sort_order
        if sort_order is None:
            current_max = (
                await db.execute(
                    select(func.max(EventQuestion.sort_order)).where(
                        EventQuestion.event_id == event_id,
                        EventQuestion.archived_at.is_(None),
                    )
                )
            ).scalar_one_or_none()
            sort_order = 0 if current_max is None else int(current_max) + 1

        now = _now()
        row = EventQuestion(
            id=body.question_id or uuid.uuid4(),
            event_id=event_id,
            organizer_id=organizer_id,
            label=body.label,
            question_type=body.question_type,
            is_required=body.is_required,
            options=list(body.options),
            sort_order=sort_order,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        await db.flush()
        await _refresh_questions_projection(db, event_id)
        await db.commit()
        await db.refresh(row)
        return _ok({"question": _serialize_question(row)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.patch("/events/{event_id}/questions/{question_id}")
async def patch_question(
    event_id: uuid.UUID,
    question_id: uuid.UUID,
    body: QuestionPatch,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _event_owner_guard(db, event_id, body.organizer_ref)
        row = (
            await db.execute(
                select(EventQuestion).where(
                    EventQuestion.id == question_id,
                    EventQuestion.event_id == event_id,
                    EventQuestion.archived_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("QUESTION_NOT_FOUND", "question not found", 404, "question_id")

        if body.label is not None:
            row.label = body.label
        if body.question_type is not None:
            row.question_type = body.question_type
        if body.is_required is not None:
            row.is_required = body.is_required
        if body.options is not None:
            row.options = list(body.options)
        row.updated_at = _now()

        await db.flush()
        await _refresh_questions_projection(db, event_id)
        await db.commit()
        await db.refresh(row)
        return _ok({"question": _serialize_question(row)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.delete("/events/{event_id}/questions/{question_id}")
async def archive_question(
    event_id: uuid.UUID,
    question_id: uuid.UUID,
    organizer_ref: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """문항 보관(soft delete). 물리 삭제하지 않는 이유는 모델 도크 참조."""
    try:
        await _event_owner_guard(db, event_id, _parse_ref(organizer_ref))
        row = (
            await db.execute(
                select(EventQuestion).where(
                    EventQuestion.id == question_id,
                    EventQuestion.event_id == event_id,
                    EventQuestion.archived_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("QUESTION_NOT_FOUND", "question not found", 404, "question_id")
        now = _now()
        row.archived_at = now
        row.updated_at = now
        await db.flush()
        await _refresh_questions_projection(db, event_id)
        await db.commit()
        return _ok({"deleted": True, "id": str(question_id)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.put("/events/{event_id}/questions/order")
async def reorder_questions(
    event_id: uuid.UUID,
    body: QuestionOrderIn,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _event_owner_guard(db, event_id, body.organizer_ref)
        rows = await _load_questions(db, event_id, include_archived=False)
        by_id = {r.id: r for r in rows}
        now = _now()
        reordered = 0
        for index, qid in enumerate(body.ordered_ids):
            row = by_id.get(qid)
            if row is None:
                continue  # 타 이벤트/보관 문항 id 는 무시(go 의 WHERE 매칭과 동일 의미).
            row.sort_order = index
            row.updated_at = now
            reordered += 1
        await db.flush()
        await _refresh_questions_projection(db, event_id)
        await db.commit()
        return _ok({"reordered": reordered})
    except ApiError as e:
        await db.rollback()
        return _err(e)


# ═════════════════════════════════════════════════════════════════════════════
# 2) 초대권 원장
# ═════════════════════════════════════════════════════════════════════════════


class InvitationReserveIn(BaseModel):
    organizer_ref: OrganizerRef
    invitation_id: uuid.UUID
    recipient_name: str = Field(..., min_length=1, max_length=200)
    phone_normalized: str = Field(..., min_length=1, max_length=32)
    phone_display: str = Field(..., min_length=1, max_length=64)
    admission_day: date_cls | None = None
    admission_mode: str | None = Field(None, max_length=20)
    # 🔴 같은 번호의 몇 번째 초대권인가. 미지정은 1 — 구버전 호출자와 하위호환.
    #    상한(`le`)을 **일부러 걸지 않는다**: 초과를 422 가 아니라 **409 INVITATION_LIMIT**
    #    으로 돌려줘야 호출자가 "seq 를 올려가다 409 에서 멈춘다" 는 단일 종료조건을
    #    쓸 수 있다. 그래야 상한 숫자가 호출자(go)에 복제되지 않는다.
    #    (le=5 로 막으면 422 가 나가고, 그 분기는 도달 불가 죽은 코드가 된다 — 뮤테이션으로 확인)
    seq: int = Field(1, ge=1, le=1000)


class InvitationIssuedIn(BaseModel):
    organizer_ref: OrganizerRef
    ticket_number: str | None = Field(None, max_length=64)


class InvitationFailedIn(BaseModel):
    organizer_ref: OrganizerRef
    reason: str = Field(..., min_length=1, max_length=500)


class InvitationRefIn(BaseModel):
    organizer_ref: OrganizerRef


class InvitationTransferIn(BaseModel):
    """초대권 양도 — 받는 사람 정보만 받는다.

    🔴 인증 코드가 없다. 이 시스템의 소유 증명은 **링크 소지**이고 게이트는 QR 만 본다.
       보내는 사람은 링크로 화면에 들어왔다는 것으로, 받는 사람은 그 번호로 알림톡을
       받는다는 것으로 증명된다. SMS 2단계를 넣으면 VIP 100장 배포가 100번 인증이 된다
       (기존 `transfers.py` 의 SMS 인증은 **회원 간 유료 티켓** 양도용이라 여기 안 맞는다).
    """

    organizer_ref: OrganizerRef
    to_name: str = Field(..., min_length=1, max_length=200)
    to_phone_normalized: str = Field(..., min_length=1, max_length=32)
    to_phone_display: str = Field(..., min_length=1, max_length=64)


class InvitationMarkIn(BaseModel):
    state: str = Field(..., pattern="^(viewed|checked_in)$")


def _digits(v: "str | None") -> str:
    """전화번호 비교용 — 표기(하이픈·공백) 차이를 낡음으로 오해하지 않는다."""
    return "".join(ch for ch in (v or "") if ch.isdigit())


def _serialize_invitation(
    row: EventInvitation, dispatch: "InvitationDispatch | None" = None
) -> dict:
    """초대권 원장 직렬화.

    🔴 `dispatch` 는 **가산 필드**다(2026-08-04). 안 주면 `None` 이 실린다 —
       소비자가 안 읽어도 깨지지 않아야 하므로 기존 필드는 하나도 안 건드린다.

    ## 왜 큐 상태를 실어야 하나

    종전 응답에는 `status`·`sent_at`·`failure_reason` 은 있고 **큐 정보가 하나도 없었다.**
    화면이 가진 것이 `status='issued'` + `sent_at=null` 뿐이라

        「큐에서 순서 기다리는 중」  과  「큐에 아예 안 들어감」

    이 **같은 픽셀로** 보인다. 2026-08-04 에 5건이 「발권됨」으로만 뜬 이유다
    (실제로는 큐가 옛 'sent' 라 아무도 못 받는 상태였다).

    ⚠️ 호출부가 큐를 **outer 로** 얹어야 한다. inner join 으로 짜면 큐가 없는 초대권이
       목록에서 통째로 사라진다.
    """
    return {
        "id": str(row.id),
        "event_id": str(row.event_id),
        "recipient_name": row.recipient_name,
        "phone_normalized": row.phone_normalized,
        "phone_display": row.phone_display,
        "seq": int(row.seq),
        "ticket_number": row.ticket_number,
        "admission_day": _ymd(row.admission_day),
        "admission_mode": row.admission_mode,
        "token_version": int(row.token_version),
        "status": row.status,
        "failure_reason": row.failure_reason,
        "sent_at": _iso(row.sent_at),
        "viewed_at": _iso(row.viewed_at),
        "checked_in_at": _iso(row.checked_in_at),
        "revoked_at": _iso(row.revoked_at),
        "created_at": _iso(row.created_at),
        # ── 가산: 큐 상태 (없으면 null) ──
        "dispatch_status": (str(dispatch.status) if dispatch is not None else None),
        "send_epoch": (int(dispatch.send_epoch) if dispatch is not None else None),
        # 🔴 **큐가 마지막으로 움직인 시각.** 화면의 "몇 분째 대기" 는 이 값으로 재야 한다.
        #
        #    2026-08-04 실사고: 재발송을 눌러 큐가 열렸는데(queued·epoch+1) 배너가
        #    「1470분째 대기」 그대로였다. 화면이 **초대권 생성 시각**으로 재고 있었기
        #    때문이다. 어제 발급된 초대권을 방금 다시 큐에 넣으면 대기 시간은 0분이지
        #    24시간이 아니다. 주최자는 "안 먹혔나" 하고 한 번 더 누른다 —
        #    그러면 손님이 두 장 받는다.
        #
        #    ⚠️ `created_at`(초대권 생성)과 **다른 값**이다. 큐 없는 행은 `null` 이고,
        #       그때는 화면이 종전대로 `created_at` 으로 잰다(옛 방어선 보존).
        "dispatch_updated_at": (_iso(dispatch.updated_at) if dispatch is not None else None),
        # 🔴 **보낸 대상이 지금 주인인가** (2026-08-12 실사고).
        #
        #    양도는 주인을 바꾸고 `sent_at` 을 지워 재발송 대상으로 되돌린다. 그런데
        #    종전 발송이 옛 스냅샷 번호로 나가면서 `sent_at` 을 **다시 찍었다**.
        #    화면 정책(resend-policy.ts)은 "sent_at 이 있으면 이미 받았다"로 보므로
        #    재발송 버튼이 사라졌다 — 손님은 못 받았는데 **복구 수단이 화면에 없었다.**
        #
        #    ⟹ 「보냈다」와 「그 사람에게 보냈다」는 다르다. 그 차이를 화면에 준다.
        #    ⚠️ 발송 큐가 없으면(아직 한 번도 안 보냄) `False` 다 — 낡음이 아니라 미발송이고,
        #       그 판정은 기존 `dispatch_status`/`sent_at` 이 이미 한다.
        "dispatch_stale": (
            dispatch is not None
            and _digits(dispatch.phone) != _digits(row.phone_normalized)
        ),
    }


async def _invitation_owner_guard(
    db: AsyncSession, invitation_id: uuid.UUID, ref: OrganizerRef
) -> EventInvitation:
    organizer_id = await _resolve_organizer(db, ref)
    row = (
        await db.execute(
            select(EventInvitation).where(EventInvitation.id == invitation_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise ApiError("INVITATION_NOT_FOUND", "invitation not found", 404, "invitation_id")
    owner = (
        await db.execute(select(Event.organizer_id).where(Event.id == row.event_id))
    ).scalar_one_or_none()
    if owner is None or owner != organizer_id:
        raise ApiError("INVITATION_NOT_FOUND", "invitation not found", 404, "invitation_id")
    return row


@router.get("/events/{event_id}/invitations")
async def list_invitations(
    event_id: uuid.UUID,
    organizer_ref: str = Query(...),
    status: str | None = Query(None),
    limit: int = Query(200, ge=1, le=_MAX_LIST_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """추적 목록 + 상태 집계 + 유효 발급 수(캡 계산 기준)."""
    try:
        await _event_owner_guard(db, event_id, _parse_ref(organizer_ref))

        stmt = select(EventInvitation).where(EventInvitation.event_id == event_id)
        if status:
            stmt = stmt.where(EventInvitation.status == status)
        stmt = stmt.order_by(EventInvitation.created_at.desc()).limit(limit)
        rows = list((await db.execute(stmt)).scalars().all())

        # 🔴 큐 상태를 **별도 조회**로 얹는다. join 으로 짜면 outer 를 빠뜨리기 쉽고,
        #    inner 가 되는 순간 **큐가 없는 초대권이 목록에서 통째로 사라진다**
        #    (발권 전 예약분이 전부 안 보인다).
        dispatch_by_inv: dict = {}
        if rows:
            dispatch_by_inv = {
                d.invitation_id: d
                for d in (
                    await db.execute(
                        select(InvitationDispatch).where(
                            InvitationDispatch.invitation_id.in_([r.id for r in rows])
                        )
                    )
                ).scalars().all()
            }

        agg = (
            await db.execute(
                select(EventInvitation.status, func.count())
                .where(EventInvitation.event_id == event_id)
                .group_by(EventInvitation.status)
            )
        ).all()
        summary = {str(s): int(n) for s, n in agg}
        active_count = sum(n for s, n in summary.items() if s != "revoked")

        return _ok(
            {
                "invitations": [
                    _serialize_invitation(r, dispatch_by_inv.get(r.id)) for r in rows
                ],
                "summary": summary,
                "active_count": active_count,
            }
        )
    except ApiError as e:
        return _err(e)


class InvitationNextSeqIn(BaseModel):
    organizer_ref: OrganizerRef
    # 한 배치가 10,000명까지 올라온다(go bulk 상한). 나눠 보내도 되게 상한을 둔다.
    phones: list[str] = Field(..., min_length=1, max_length=2000)


@router.post("/events/{event_id}/invitations/next-seq")
async def invitation_next_seq(
    event_id: uuid.UUID,
    body: InvitationNextSeqIn,
    db: AsyncSession = Depends(get_db),
):
    """번호별 **다음 빈 순번**을 한 번에 돌려준다 — 대량초대 왕복 축소용.

    ## 🔴 왜 필요한가 (2026-08-09, 상한 5 → 50)

    go 는 번호마다 `seq` 를 1부터 올려가며 두드리고 409 에서 멈춘다. 상한이 5 일 땐
    최악 5회였지만 50 이면 **41회**가 되고, bulk 상한이 10,000명이라
    **최악 50만 회 왕복**이다. 그 라우트엔 `maxDuration` 도 없다 —
    상한만 올리면 대량초대는 느려지는 게 아니라 **못 쓰게 된다**.

    ## 🔴 이것은 **힌트**이지 권위가 아니다

    상한 집행은 여전히 reserve 의 409 다. 이 값이 낡아도(동시 업로드) go 는 거기서부터
    올려가며 두드리므로 결과가 같다. **호출자가 세면 동시 요청에 뚫린다**는 원칙을
    깨지 않는다 — 세는 게 아니라 **출발점만** 당긴다.

    ## 🔴 왜 seq 자동배정을 하지 않았나

    재업로드 멱등의 열쇠가 **클라가 준 seq** 다(`_existing()` 이
    `(event, phone, seq)` 로 기존 행을 찾는다). 서버가 자동 배정하면 그 열쇠가 사라져
    **같은 명단을 다시 올리면 빈 자리에 새 티켓이 또 발급된다.**

        go 배치 지문(invitation-batch-key.ts)   명단이 **완전히 같을 때만** 막는다
                                                한 명만 추가돼도 지문이 바뀌어 전원 재처리
        reserve 의 invitation_id               업로드마다 새 randomUUID — 행을 특정 못 한다

    ⟹ 둘 다 멱등을 보장하지 못한다. 그래서 자동배정을 **열지 않았다**.

    ## 회수분 처리

    reserve 는 회수(revoked)된 행을 **같은 seq 에서 되살린다**. 그래서 revoked 는
    **빈 자리**로 센다 — 그러지 않으면 힌트가 회수 자리를 건너뛴다.
    (양도 경로는 revoked 를 점유로 본다 — 규칙이 달라 참조하면 안 된다.)

    🔴 `failed` 도 빈 자리로 센다. 힌트는 **낮은 쪽으로 틀리는 것이 안전**하다 —
       낮으면 왕복 몇 번을 더 쓰고 끝이지만, 높으면 되살릴 자리를 건너뛰어
       **초대권이 중복 발급**된다.

    응답: `{"next": {"<phone>": 3, ...}, "at_limit": ["<phone>", ...]}`

    ⚠️ 자리 없음을 `at_limit` 로 **명시**한다. `MAX+1` 만 주면 호출자가 그걸 알아보려고
       상한 숫자를 알아야 하고, 그 복제를 피하는 것이 이 설계의 전제다.
    """
    try:
        # reserve 와 **같은 가드**를 쓴다 — 남의 행사 번호로 자리 정보를 캐가지 못하게.
        await _event_owner_guard(db, event_id, body.organizer_ref)
    except ApiError as e:
        return _err(e)

    phones = list(dict.fromkeys(p for p in body.phones if p))
    if not phones:
        return _ok({"next": {}})

    rows = (
        await db.execute(
            select(EventInvitation.phone_normalized, EventInvitation.seq).where(
                EventInvitation.event_id == event_id,
                EventInvitation.phone_normalized.in_(phones),
                # 🔴 **보수적으로** 센다 — 되살아날 수 있는 상태는 전부 "빈 자리" 로 본다.
                #
                #    힌트가 **낮으면** 손해가 왕복 몇 번뿐이다(reserve 가 created=false 를
                #    주면 호출자가 올려간다). 힌트가 **높으면** 되살릴 수 있는 자리를
                #    건너뛰고 **새 행이 생긴다** — 초대권 중복 발급이다.
                #    ⟹ 비대칭이 크므로 낮은 쪽으로 틀린다.
                #
                #    ⚠️ 실제로 이 판단이 값을 냈다: go 테스트의 v2 페이크는 `failed` 행도
                #       부활시키는데, prod v2(2e1bcce4)에는 그 분기가 **없다**
                #       (INVITATION_ORPHAN_TICKET 0건). 둘 중 어느 쪽이 맞든 힌트를
                #       낮게 두면 결과가 같다.
                EventInvitation.status.not_in(("revoked", "failed")),
            )
        )
    ).all()

    used: dict[str, set[int]] = {}
    for phone, seq in rows:
        used.setdefault(phone, set()).add(int(seq))

    out: dict[str, int] = {}
    at_limit: list[str] = []
    for phone in phones:
        taken = used.get(phone, set())
        free = next(
            (n for n in range(1, INVITATION_MAX_PER_PHONE + 1) if n not in taken), None
        )
        if free is None:
            # 🔴 자리 없음을 **명시적으로** 알린다. MAX+1 만 주면 호출자가 그게 상한 초과인지
            #    알려면 상한 숫자를 알아야 한다 — 그 복제를 피하는 게 이 설계의 전제다.
            #    (숫자를 모르면 호출자는 51 부터 가드까지 헛되이 두드린다.)
            at_limit.append(phone)
            out[phone] = INVITATION_MAX_PER_PHONE + 1
        else:
            out[phone] = free
    return _ok({"next": out, "at_limit": at_limit})


@router.post("/events/{event_id}/invitations/reserve")
async def reserve_invitation(
    event_id: uuid.UUID,
    body: InvitationReserveIn,
    db: AsyncSession = Depends(get_db),
):
    """발권 **전** 원자 예약. dedup·동시성의 유일한 집행 지점.

    `created=true` 를 받은 호출자만 실제 발권(v2 주문 생성)을 진행한다.

    ## 🔴 1인 다장 (2026-07-30) — `seq` 기준 예약
    같은 번호에 **최대 `INVITATION_MAX_PER_PHONE` 장**까지 발급된다(대회 요건: 5장).
    유일성은 `(event_id, phone_normalized, seq)` 다.

      · 같은 `seq` 가 이미 있으면 → `created=false` + 기존 행 (**재업로드·동시 패자 멱등**)
      · 그 번호의 발급 수가 이미 상한이면 → **409 `INVITATION_LIMIT`**

    ⚠️ 호출자 계약: `seq` 를 1부터 올려가며 `created=true` 를 받을 때까지 시도하고,
       **409 `INVITATION_LIMIT` 을 종료 조건**으로 쓴다. 상한 판정을 호출자가 세지 않는다
       (동시 요청에 뚫린다 — 상한은 DB CHECK + 이 지점이 원자 집행).
       판정은 **`error.code`** 로 한다 — 409 는 `CONFLICT` 도 쓴다.

    🔴 **응답의 `invitation.id` 는 요청한 `invitation_id` 와 다를 수 있다.**
       회수(`revoked`) 행 부활 경로에서는 **기존 행(원래 id)** 을 되살려 돌려주므로,
       호출자가 방금 만든 요청 id 를 계속 쓰면 이후 `issued`/`failed` 마킹이
       **없는 행**을 가리킨다 → 티켓은 발권되는데 초대권에 티켓번호가 안 붙어
       **링크가 죽는다. 예외는 나지 않는다.**
       ⟹ 호출자는 **항상 응답의 `invitation.id` 를 정본으로** 이후 호출에 쓴다.
       (2026-07-30 상대 세션이 go 구현에서 실제로 이 결함을 냈고, 계약서에 이 문장이
        없어서 놓쳤다고 지적했다 — 내 문서 누락이다.)
    """
    try:
        organizer_id = await _event_owner_guard(db, event_id, body.organizer_ref)

        async def _existing() -> EventInvitation | None:
            """이 번호의 **이 순번** 행. 순번이 유일성의 일부다."""
            return (
                await db.execute(
                    select(EventInvitation).where(
                        EventInvitation.event_id == event_id,
                        EventInvitation.phone_normalized == body.phone_normalized,
                        EventInvitation.seq == body.seq,
                    )
                )
            ).scalar_one_or_none()

        # 🔴 순번 자체가 상한을 넘으면 409 — 호출자의 종료 조건.
        if body.seq > INVITATION_MAX_PER_PHONE:
            raise ApiError(
                "INVITATION_LIMIT",
                f"이 번호에는 최대 {INVITATION_MAX_PER_PHONE}장까지 발급할 수 있습니다",
                409,
                "seq",
            )

        prior = await _existing()
        if prior is not None:
            # 🔴 회수(revoked)된 행은 **순번 자리를 되돌려준다**(재사용).
            #    이 분기가 없으면: 잘못 보낸 초대권을 회수해도 그 seq 에 행이 남아
            #    `created=false` 가 재생되고, 호출자는 스킵한다 →
            #    **그 번호로는 이 행사에서 영구히 재발급 불가**. 상한 계산에서 revoked 를
            #    제외해도 자리가 비지 않으므로 아무 의미가 없다(뮤테이션으로 확인함).
            if prior.status == "revoked":
                prior.status = "issued"
                prior.failure_reason = None
                # 🔴 revoked_at 도 비운다. 남겨두면 `status="issued"` 인데 `revoked_at` 이
                #    채워진 **모순된 행**이 생긴다. 지금 읽는 곳은 없지만(v2 판정 0건,
                #    go 는 응답에만 실어 미소비) 이 리포에는 `revoked_at IS NULL` 로 유효성을
                #    보는 관용구가 이미 있다(delegation_token.py:38 부분인덱스 ·
                #    middleware/auth.py:169 · delegation_service.py:168,374).
                #    초대권에 같은 관용구를 쓰는 순간 **부활된 초대권이 회수된 것으로 판정**된다.
                prior.revoked_at = None
                prior.ticket_number = None  # 새 티켓을 받는다(옛 티켓은 회수됨)
                prior.sent_at = None
                prior.viewed_at = None
                # 수신자 정보는 최신 요청 값으로 갱신 — 회수 후 **다른 사람에게** 줄 수 있다.
                prior.recipient_name = body.recipient_name
                prior.phone_display = body.phone_display
                prior.admission_day = body.admission_day
                prior.admission_mode = body.admission_mode
                prior.updated_at = _now()
                # token_version 은 올리지 않는다 — revoke 가 이미 올려 옛 링크는 죽어 있다.
                await db.commit()
                await db.refresh(prior)
                return _ok(
                    {"created": True, "invitation": _serialize_invitation(prior)}
                )
            return _ok(
                {"created": False, "invitation": _serialize_invitation(prior)}, replay=True
            )

        # 상한 확인 — 회수(revoked)분은 자리를 비워준다(위 부활 분기와 짝).
        issued_count = (
            await db.execute(
                select(func.count())
                .select_from(EventInvitation)
                .where(
                    EventInvitation.event_id == event_id,
                    EventInvitation.phone_normalized == body.phone_normalized,
                    EventInvitation.status != "revoked",
                )
            )
        ).scalar() or 0
        if issued_count >= INVITATION_MAX_PER_PHONE:
            raise ApiError(
                "INVITATION_LIMIT",
                f"이 번호에는 최대 {INVITATION_MAX_PER_PHONE}장까지 발급할 수 있습니다 "
                f"(현재 {issued_count}장)",
                409,
                "seq",
            )

        now = _now()
        row = EventInvitation(
            id=body.invitation_id,
            event_id=event_id,
            organizer_id=organizer_id,
            recipient_name=body.recipient_name,
            phone_normalized=body.phone_normalized,
            phone_display=body.phone_display,
            seq=body.seq,
            admission_day=body.admission_day,
            admission_mode=body.admission_mode,
            token_version=0,
            status="issued",
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            # 동시 2회 — 유니크가 두 번째를 튕겼다. 승자를 읽어 멱등 재생.
            await db.rollback()
            winner = await _existing()
            if winner is None:
                raise ApiError(
                    "CONFLICT", "invitation conflict", 409, "phone_normalized"
                ) from None
            return _ok(
                {"created": False, "invitation": _serialize_invitation(winner)},
                replay=True,
            )
        await db.refresh(row)
        return _ok({"created": True, "invitation": _serialize_invitation(row)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.post("/invitations/{invitation_id}/issued")
async def mark_invitation_issued(
    invitation_id: uuid.UUID,
    body: InvitationIssuedIn,
    db: AsyncSession = Depends(get_db),
):
    """발권 성공 반영 + 발송 큐 적재를 **한 트랜잭션**으로.

    go 는 이 둘을 각각 UPDATE / INSERT 로 보냈고 그 사이에 crash 하면 티켓번호는 있는데
    큐가 없는 조용한 미발송이 남았다. 여기서 원자화한다.
    """
    try:
        row = await _invitation_owner_guard(db, invitation_id, body.organizer_ref)
        now = _now()
        row.ticket_number = body.ticket_number
        row.updated_at = now

        dispatch = (
            await db.execute(
                select(InvitationDispatch).where(
                    InvitationDispatch.invitation_id == invitation_id
                )
            )
        ).scalar_one_or_none()
        queued = False
        if dispatch is None:
            db.add(
                InvitationDispatch(
                    invitation_id=invitation_id,
                    event_id=row.event_id,
                    organizer_id=row.organizer_id,
                    phone=row.phone_display,
                    recipient_name=row.recipient_name,
                    status="queued",
                    created_at=now,
                    updated_at=now,
                )
            )
            queued = True
        elif str(dispatch.status) in ("sent", "failed") and row.sent_at is None:
            # 🔴 회수 → 같은 명단 재업로드 → 재발권 경로. 여기가 비어 있어서
            #    **알림톡이 영원히 안 나갔다**(2026-08-04 prod 5건, 1370분 대기).
            #
            #    reserve_invitation 의 "부활" 분기가 ticket_number·sent_at 을 비우고
            #    status='issued' 로 되돌리지만, **큐는 옛 'sent' 그대로**다.
            #    티켓은 재발권됐는데 아무도 큐를 안 열어 드레이너가 집지 않는다.
            #
            #    비교군이 원인을 갈랐다(prod 실측):
            #      양도       resend_invitation 을 타서 epoch 1·attempt 2 → 나감  ✅
            #      회수→재발급 아무도 큐를 안 엶 · epoch 0·attempt 1   → 🔴 안 나감
            #
            #    이 함수의 독스트링은 "티켓번호는 있는데 큐가 없는 조용한 미발송을
            #    여기서 원자화한다" 고 적고 있다. **반대 방향이 비어 있었다.**
            #
            # 🔴 경계 — 여기가 생명줄이다. 잘못 열면 손님이 초대권을 두 장 받는다.
            #    ① status='queued' 면 건드리지 않는다 — 정상 최초 발권·동시 적재 경합이
            #       거기다. 손대면 두 번 나간다. (그래서 터미널 상태만 본다)
            #    ② row.sent_at 이 있으면 건드리지 않는다 — 이미 받은 사람이다.
            #    ③ send_epoch 를 **반드시** 올린다. epoch 가 멱등키를 가른다
            #       ("crash 재시도" vs "명시적 재발송"). 안 올리면 NCP 가 같은 키로 보고
            #       조용히 씹는다 — 고쳐도 안 나간다.
            #    ④ 같은 트랜잭션에 둔다. ticket_number 갱신과 갈라지면 지금과 같은
            #       반쪽 상태가 다시 생긴다(이 함수가 애초에 그걸 원자화하려 만들어졌다).
            dispatch.status = "queued"
            dispatch.claim_token = None
            dispatch.claim_expires_at = None
            dispatch.last_error = None
            dispatch.send_epoch = int(dispatch.send_epoch) + 1
            dispatch.updated_at = now
            queued = True
        try:
            await db.commit()
        except IntegrityError:
            # 큐 UNIQUE(invitation_id) — 동시 적재. 이미 큐가 있으므로 성공으로 수렴.
            await db.rollback()
            queued = False
            await db.execute(
                update(EventInvitation)
                .where(EventInvitation.id == invitation_id)
                .values(ticket_number=body.ticket_number, updated_at=now)
            )
            await db.commit()
            row = (
                await db.execute(
                    select(EventInvitation).where(EventInvitation.id == invitation_id)
                )
            ).scalar_one()
            return _ok({"invitation": _serialize_invitation(row), "queued": queued})
        await db.refresh(row)
        return _ok({"invitation": _serialize_invitation(row), "queued": queued})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.post("/invitations/{invitation_id}/failed")
async def mark_invitation_failed(
    invitation_id: uuid.UUID,
    body: InvitationFailedIn,
    db: AsyncSession = Depends(get_db),
):
    try:
        row = await _invitation_owner_guard(db, invitation_id, body.organizer_ref)
        row.status = "failed"
        row.failure_reason = body.reason
        row.updated_at = _now()
        await db.commit()
        await db.refresh(row)
        return _ok({"invitation": _serialize_invitation(row)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.post("/invitations/{invitation_id}/revoke")
async def revoke_invitation(
    invitation_id: uuid.UUID,
    body: InvitationRefIn,
    db: AsyncSession = Depends(get_db),
):
    """회수 — 티켓 무효화 + nonce++ (기 발송 링크 즉시 무효) + 대기 큐 제거.

    ## 🔴 종전에는 티켓을 죽이지 않았다 (2026-07-31 대표 결정으로 변경)
    `token_version` 만 올려 **딥링크만** 막았다. `tickets` 는 한 번도 건드리지 않아
    회수된 초대권의 티켓이 `active` 로 남았다(실측: `TKT-50A028F727D7`).
    회전 QR 이라 링크가 죽으면 QR 생성이 안 돼 실질 입장은 막혔지만,
    **티켓번호로 검증하는 경로가 생기는 순간 뚫린다** — 현장 등록업체 게이트 연동을
    논의 중이라 그 가정을 남겨둘 수 없다.

    ⟹ 티켓을 `CANCELLED` 로 전이한다. 두 가지가 함께 일어난다:
      · 입장 차단 — `admission_service.py:163` 이 `CANCELLED`/`EXPIRED` 를 거부한다
      · 재고 반환 — `trg_sync_sold_count` 트리거가 `sold_count` 를 1 줄인다
        (`cancelled`/`expired` 로 이탈할 때). **직접 빼지 않는다** — 이중 감산이 된다.

    ## 🔴 이미 입장한 초대권은 회수하지 않는다
    `USED` 를 `CANCELLED` 로 바꾸면 입장 기록이 남은 사람이 "티켓 없음" 이 되고,
    트리거가 `sold_count` 를 **한 번 더** 줄여 집계가 틀어진다(USED 는 자리 점유).
    ⟹ 409 로 거부하고 사유를 돌려준다. 화면도 그 행의 버튼을 비활성화한다(이중 방어).
    """
    try:
        row = await _invitation_owner_guard(db, invitation_id, body.organizer_ref)
        if row.status == "revoked":
            return _ok({"revoked": False, "invitation": _serialize_invitation(row)})

        # 원장 상태로 먼저 거른다(티켓 조회 전에 값싼 판정).
        if row.status == "checked_in":
            raise ApiError(
                "INVITATION_ALREADY_CHECKED_IN",
                "이미 입장한 초대권은 회수할 수 없습니다.",
                409,
                "status",
            )

        ticket: Ticket | None = None
        if row.ticket_number:
            ticket = (
                await db.execute(
                    select(Ticket).where(Ticket.ticket_number == row.ticket_number).with_for_update()
                )
            ).scalar_one_or_none()
            # 원장이 checked_in 을 놓쳤어도 티켓이 진실을 안다(체크인은 티켓에 먼저 쓴다).
            if ticket is not None and ticket.status == TicketStatus.USED:
                raise ApiError(
                    "INVITATION_ALREADY_CHECKED_IN",
                    "이미 입장한 초대권은 회수할 수 없습니다.",
                    409,
                    "status",
                )

        now = _now()
        row.status = "revoked"
        row.token_version = int(row.token_version) + 1
        row.revoked_at = now
        row.updated_at = now
        # 🔴 티켓 무효화. 이미 cancelled 면 건드리지 않는다 — 트리거가 두 번 줄인다.
        if ticket is not None and ticket.status != TicketStatus.CANCELLED:
            ticket.status = TicketStatus.CANCELLED
        await db.execute(
            delete(InvitationDispatch).where(
                InvitationDispatch.invitation_id == invitation_id,
                InvitationDispatch.status.in_(("queued", "failed")),
            )
        )
        await db.commit()
        await db.refresh(row)
        return _ok({"revoked": True, "invitation": _serialize_invitation(row)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


async def _retitle_invitation_order(
    db: AsyncSession, invitation: EventInvitation, invitation_id: uuid.UUID
) -> None:
    """양도된 초대권의 **주문 구매자**를 새 주인으로 바꾼다.

    ## 🔴 왜 필요한가 (2026-08-03 첫 실사용에서 드러남)

    양도는 `event_invitations`(이름·번호·token_version)와 `tickets`(QR)만 바꿨다.
    그런데 **화면 셋이 `orders.buyer_*` 를 본다**:

        현장 체크인 화면    check-in/route.ts:209  `ticket.order.buyer?.name` → 응답 8곳
        주최자 참석자 목록  AttendeeListRow.name   ("order.buyer_name → owner 폴백")
        손님 차단 화면      order.buyer.name

    🔴 게이트에서 스캔했는데 **다른 이름**이 뜨면 그 자리에서 실랑이가 난다. D-16.
    (초대권 앞면은 `invitation.recipient_name` 을 쓰므로 이미 정상이었다 —
     `page.tsx:391` 의 초대권 분기가 유료 분기 앞에서 return 한다.)

    ## 🔴 경계 셋 — 여기가 생명줄이다

    ① **`buyer_email` 은 절대 안 바꾼다.** 발급 멱등 앵커다
       (`invite-<invitationId>@no-reply.pickket.kr`, `idempotencyToken` 과 짝).
       바꾸면 정당한 재시도가 409 가 된다 — 07-31 실사고가 정확히 이 자리였다.

    ② **초대권 주문에만 적용한다.** 판별자는 `tickets.answers._invitationId` 다.
       ⚠️ `buyer_email.startswith("invite-")` 같은 문자열 판별은 쓰지 않는다 —
          유료 주문의 buyer 가 바뀌면 "누가 결제했나" 가 사라진다.
       ⚠️ 초대권은 주문당 티켓 1장이지만(prod 9건 실측) 유료 주문은 여럿일 수 있다.
          판별자가 깨지면 **남의 티켓 표시명까지** 바뀐다.

    ③ **ORM 대입으로 한다(bulk update 금지).**
       `Order.buyer_phone` 에는 `@validates` 가 걸려 있어(`models/order.py:258`)
       대입 시 `buyer_phone_lookup_hash` 를 같이 갱신한다.
       `update(Order).values(...)` 는 validator 를 **안 타서** 해시가 옛 번호로 남는다.
       ⚠️ 지금은 그 해시로 조회하는 경로가 초대권에 도달 불가라(합성 이메일 AND 조건)
          관측되는 실패가 없다. 그래도 틀린 값을 남기지 않는다 — 이메일 정책이 바뀌는
          순간 조용히 어긋난다.

    실패해도 예외를 올리지 않는다: 양도 자체는 이미 성립했고, 표시 갱신 실패로
    양도를 되돌리면 "티켓은 넘어갔는데 양도 실패" 가 된다.
    """
    from app.models.order import Order
    from app.models.order_item import OrderItem

    ticket = (
        await db.execute(
            select(Ticket).where(Ticket.ticket_number == invitation.ticket_number)
        )
    ).scalar_one_or_none()
    if ticket is None or ticket.order_item_id is None:
        return

    # 🔴 판별자 — 이 티켓이 **이 초대권**으로 발권된 것인가.
    answers = ticket.answers if isinstance(ticket.answers, dict) else {}
    if str(answers.get("_invitationId") or "") != str(invitation_id):
        logger.warning(
            "초대권 양도 — 티켓의 _invitationId 가 일치하지 않아 주문 구매자를 건드리지 않는다: "
            "ticket=%s answers=%s",
            invitation.ticket_number,
            answers.get("_invitationId"),
        )
        return

    order = (
        await db.execute(
            select(Order)
            .join(OrderItem, OrderItem.order_id == Order.id)
            .where(OrderItem.id == ticket.order_item_id)
        )
    ).scalar_one_or_none()
    if order is None:
        return

    # ORM 대입 — validator 가 lookup_hash 를 같이 갱신한다.
    order.buyer_name = invitation.recipient_name
    order.buyer_phone = invitation.phone_display or invitation.phone_normalized
    # 🔴 buyer_email 은 손대지 않는다(멱등 앵커).


@router.post("/invitations/{invitation_id}/transfer")
async def transfer_invitation(
    invitation_id: uuid.UUID,
    body: InvitationTransferIn,
    db: AsyncSession = Depends(get_db),
):
    """초대권 양도 — 받는 사람 정보로 **제자리 갱신**하고 옛 링크를 죽인다.

    ## 왜 새 행이 아니라 제자리 갱신인가 (2026-08-03 대표 확정)

    `ticket_number` 는 **원장 4곳**의 키다:

        v2 tickets · v2 event_invitations · v2 check_in_logs · go attendees

    새 행을 만들면 같은 좌석이 명단에 두 벌이 된다("양도함" 한 줄 + "유효" 한 줄).
    🔴 대회 당일 입구에서 그걸 보고 판단해야 한다 — **현장에서 헷갈리면 그게 사고다.**
    제자리 갱신은 명단에 한 줄만 남기고, 거기 적힌 사람이 들어온다.

    옛 링크 무효화는 **이미 있는 장치**를 그대로 쓴다 — `token_version` 을 올리면
    기 발송된 딥링크의 서명 payload(`{ticketNumber, v}`)가 원장과 어긋나 즉시 죽는다
    (`revoke_invitation` 이 쓰는 것과 같은 방식).

    양도 이력은 원장이 아니라 **감사로그**에 남는다 — 원장은 "지금 주인"만 들고 있으면 된다.

    ## 동시성

    🔴 초대권 행을 `FOR UPDATE` 로 잠근다. 두 사람이 같은 링크로 동시에 양도를 눌러도
    하나만 성공한다. 잠금 없이 하면 둘 다 통과해 **마지막 UPDATE 가 이긴다** —
    앞사람은 성공 화면을 보는데 실제 소유자는 뒷사람이 된다.

    ## 막는 것

        이미 회수됨(revoked)      → 양도 대상이 아니다
        🔴 이미 입장함(checked_in) → 쓴 티켓을 넘길 수 없다
        받는 사람이 5장 초과       → 409 INVITATION_LIMIT (대표 확정: 막고 안내)
        자기 자신에게 양도         → 무의미. 토큰만 죽어 손님이 링크를 잃는다
    """
    try:
        organizer_id = await _resolve_organizer(db, body.organizer_ref)
        # 🔴 owner guard 는 잠그지 않는다(`_invitation_owner_guard`). 양도는 잠가야 하므로
        #    여기서 직접 FOR UPDATE 로 읽는다.
        row = (
            await db.execute(
                select(EventInvitation)
                .where(EventInvitation.id == invitation_id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("INVITATION_NOT_FOUND", "invitation not found", 404, "invitation_id")
        owner = (
            await db.execute(select(Event.organizer_id).where(Event.id == row.event_id))
        ).scalar_one_or_none()
        if owner is None or owner != organizer_id:
            raise ApiError("INVITATION_NOT_FOUND", "invitation not found", 404, "invitation_id")

        if row.status == "revoked":
            raise ApiError(
                "INVITATION_REVOKED", "회수된 초대권은 양도할 수 없습니다", 409, "status"
            )
        if row.checked_in_at is not None:
            raise ApiError(
                "INVITATION_USED", "이미 입장한 초대권은 양도할 수 없습니다", 409, "status"
            )

        from_name, from_phone = row.recipient_name, row.phone_normalized
        to_phone = body.to_phone_normalized.strip()
        if to_phone == from_phone:
            raise ApiError(
                "INVITATION_SELF_TRANSFER",
                "같은 번호로는 양도할 수 없습니다",
                409,
                "to_phone_normalized",
            )

        # 받는 사람 상한 — 회수분은 자리를 비워준다(reserve 와 같은 규칙).
        held = (
            await db.execute(
                select(func.count())
                .select_from(EventInvitation)
                .where(
                    EventInvitation.event_id == row.event_id,
                    EventInvitation.phone_normalized == to_phone,
                    EventInvitation.status != "revoked",
                )
            )
        ).scalar() or 0
        if held >= INVITATION_MAX_PER_PHONE:
            raise ApiError(
                "INVITATION_LIMIT",
                f"받는 분이 이미 {held}장을 갖고 계십니다 "
                f"(한 번호당 최대 {INVITATION_MAX_PER_PHONE}장)",
                409,
                "to_phone_normalized",
            )

        # 받는 사람 기준으로 seq 를 다시 매긴다 — UNIQUE(event_id, phone_normalized, seq).
        # 비어 있는 가장 작은 자리를 쓴다(회수분이 남긴 구멍을 메운다).
        used = set(
            (
                await db.execute(
                    select(EventInvitation.seq).where(
                        EventInvitation.event_id == row.event_id,
                        EventInvitation.phone_normalized == to_phone,
                    )
                )
            ).scalars().all()
        )
        next_seq = next(
            (n for n in range(1, INVITATION_MAX_PER_PHONE + 1) if n not in used), None
        )
        if next_seq is None:
            # 상한 검사를 통과했는데 자리가 없다 = 회수분이 자리를 물고 있다.
            raise ApiError(
                "INVITATION_LIMIT",
                f"받는 분의 초대권 자리가 가득 찼습니다 (최대 {INVITATION_MAX_PER_PHONE}장)",
                409,
                "to_phone_normalized",
            )

        now = _now()
        row.recipient_name = body.to_name.strip()
        row.phone_normalized = to_phone
        row.phone_display = body.to_phone_display.strip()
        row.seq = next_seq
        # 🔴 옛 딥링크 사망 — 기 발송 토큰의 v 가 어긋난다.
        row.token_version = int(row.token_version) + 1
        # 다시 보내야 하므로 발송·열람 표식을 초기화한다. 안 하면 "이미 보냄"으로 보인다.
        row.sent_at = None
        row.viewed_at = None
        row.status = "issued"
        row.failure_reason = None
        row.updated_at = now

        # 🔴 발송 큐 스냅샷도 새 주인으로 옮긴다 (2026-08-12).
        #    claim 이 초대권을 정본으로 읽으므로 **발송 자체는 이것 없이도 옳게 나간다**.
        #    그래도 갱신하는 이유는 기록이다 — 스냅샷이 옛 주인인 채 남으면 사고를 쫓는
        #    사람이 "엉뚱한 번호로 발송됐다"고 오진한다(2026-08-12 실제로 두 번 그랬다).
        await db.execute(
            update(InvitationDispatch)
            .where(InvitationDispatch.invitation_id == row.id)
            .values(
                phone=row.phone_display,
                recipient_name=row.recipient_name,
                updated_at=now,
            )
        )

        # 🔴 QR 재바인딩 — 옛 소유자의 디바이스 바인딩을 끊는다.
        #    같은 트랜잭션에 둔다. 여기서 갈라지면 링크는 새 주인, QR 은 옛 주인이 된다.
        if row.ticket_number:
            await db.execute(
                update(Ticket)
                .where(Ticket.ticket_number == row.ticket_number)
                .values(device_hash=None, totp_seed=None)
            )
            await _retitle_invitation_order(db, row, invitation_id)

        await db.commit()
        await db.refresh(row)

        # 이력은 원장이 아니라 감사로그에 — 원장은 "지금 주인"만 들고 있다.
        logger.info(
            "초대권 양도: invitation=%s event=%s %s(%s) → %s(%s) seq=%s tv=%s",
            invitation_id,
            row.event_id,
            from_name,
            from_phone,
            row.recipient_name,
            row.phone_normalized,
            row.seq,
            row.token_version,
        )
        return _ok(
            {
                "transferred": True,
                "invitation": _serialize_invitation(row),
                "from": {"recipient_name": from_name, "phone_normalized": from_phone},
            }
        )
    except IntegrityError:
        await db.rollback()
        return _err(
            ApiError("CONFLICT", "invitation conflict", 409, "to_phone_normalized")
        )
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.post("/invitations/{invitation_id}/resend")
async def resend_invitation(
    invitation_id: uuid.UUID,
    body: InvitationRefIn,
    db: AsyncSession = Depends(get_db),
):
    """재발송 — 원장 issued 복귀 + 큐 재적재 + **send_epoch++**.

    epoch 를 올리는 유일한 지점이다. 이것이 "crash 재시도(같은 키·재발송 안 함)" 와
    "주최자의 명시적 재발송(새 키·실제로 나감)" 을 가르는 경계다.
    """
    try:
        row = await _invitation_owner_guard(db, invitation_id, body.organizer_ref)
        if row.status == "revoked":
            raise ApiError("INVITATION_REVOKED", "invitation revoked", 409, "status")
        if not row.ticket_number:
            # 발권 미완 — 재발송할 티켓이 없다(재발권은 대량 재업로드 경로).
            return _ok({"requeued": False, "reason": "not_issued"})

        now = _now()
        row.status = "issued"
        row.failure_reason = None
        row.updated_at = now

        dispatch = (
            await db.execute(
                select(InvitationDispatch)
                .where(InvitationDispatch.invitation_id == invitation_id)
                # 🔴 워커의 조건부 UPDATE(claim)와 직렬화한다. 락이 없으면
                #    "queued 로 읽음 → 워커가 집어감 → 우리가 queued 로 되돌림" 창이 남아
                #    아래 거부 자체를 우회한다(TOCTOU). 락은 세션 종료 시 풀린다.
                .with_for_update()
            )
        ).scalar_one_or_none()

        # 🔴 발송 **중**이면 거부한다 (2026-08-04, 두 번째 겹).
        #
        #    화면 가드는 이미 배포됐지만 이 API 를 직접 부르는 경로가 남아 있었다.
        #    워커 A 가 보내는 중에 재발송이 들어오면 claim_token 이 지워지고 —
        #      · 워커 A 는 그대로 발송하고
        #      · 풀린 행을 워커 B 가 다시 집는다
        #    ⟹ **손님이 초대권을 두 장 받는다.**
        #
        # ⚠️ 리스 만료는 예외다. 죽은 워커가 'sending' 을 박아둔 채 사라지면 그 행은
        #    영원히 잠긴다 — 재발송으로도 못 푸는 행이 생기면 이 가드가 사고가 된다.
        #    판정은 claim 쪽과 **같은 함수**를 쓴다(_dispatch_lease_alive).
        if dispatch is not None and str(dispatch.status) == "sending" and _dispatch_lease_alive(
            dispatch, now
        ):
            raise ApiError(
                "DISPATCH_IN_FLIGHT", "dispatch in flight", 409, "dispatch_status"
            )

        if dispatch is None:
            db.add(
                InvitationDispatch(
                    invitation_id=invitation_id,
                    event_id=row.event_id,
                    organizer_id=row.organizer_id,
                    phone=row.phone_display,
                    recipient_name=row.recipient_name,
                    status="queued",
                    attempt_count=0,
                    send_epoch=0,
                    created_at=now,
                    updated_at=now,
                )
            )
        else:
            dispatch.status = "queued"
            dispatch.claim_token = None
            dispatch.claim_expires_at = None
            dispatch.last_error = None
            dispatch.send_epoch = int(dispatch.send_epoch) + 1
            dispatch.updated_at = now
        await db.commit()
        return _ok({"requeued": True})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.get("/invitations/by-ticket-number/{ticket_number}")
async def get_invitation_by_ticket(
    ticket_number: str,
    db: AsyncSession = Depends(get_db),
):
    """티켓번호로 **회수되지 않은** 초대 1건 조회.

    공개 티켓 페이지가 쓰는 두 가지를 한 번에 준다:
      1. 초대권 표기(수신자명·입장 가능 일자/규칙)
      2. 딥링크 bearer 검증용 `token_version`(nonce) — 회수 시 +1 되어 구 링크가 무효화된다.

    `revoked` 는 애초에 반환하지 않는다 → 회수된 초대의 토큰은 **매칭 자체가 없어** 접근이
    거부된다(호출부가 별도 상태 판정을 하지 않아도 되는 fail-closed 형태).
    조직 경계를 받지 않는 이유: 호출자가 티켓번호밖에 모르는 공개 열람 경로이고, 반환 필드가
    그 티켓 소지자에게 어차피 표시되는 값이다(서비스 인증으로만 접근 가능).
    """
    row = (
        await db.execute(
            select(EventInvitation).where(
                EventInvitation.ticket_number == ticket_number,
                EventInvitation.status != "revoked",
            )
        )
    ).scalars().first()
    if row is None:
        return _ok({"invitation": None})
    return _ok(
        {
            "invitation": {
                "id": str(row.id),
                "recipient_name": row.recipient_name,
                "admission_day": _ymd(row.admission_day),
                "admission_mode": row.admission_mode,
                "token_version": int(row.token_version),
                "status": row.status,
            }
        }
    )


@router.post("/invitations/by-ticket-number/{ticket_number}/mark")
async def mark_invitation_by_ticket(
    ticket_number: str,
    body: InvitationMarkIn,
    db: AsyncSession = Depends(get_db),
):
    """열람/입장 훅 — 티켓번호로 초대를 찾아 상태 전이.

    초대권이 아닌 일반 티켓은 매칭 0건(무영향). `revoked` 는 건드리지 않는다.
    조직 경계를 받지 않는 이유: 호출자(공개 티켓 페이지·현장 체크인)가 티켓번호밖에
    모르고, 이 연산은 **자기 자신의 발송 상태 갱신**이라 타 테넌트 데이터를 반환하지 않는다
    (응답은 갱신 건수뿐).
    """
    now = _now()
    if body.state == "viewed":
        stmt = (
            update(EventInvitation)
            .where(
                EventInvitation.ticket_number == ticket_number,
                EventInvitation.status.in_(("sent", "issued")),
            )
            .values(
                status="viewed",
                viewed_at=func.coalesce(EventInvitation.viewed_at, now),
                updated_at=now,
            )
        )
    else:
        stmt = (
            update(EventInvitation)
            .where(
                EventInvitation.ticket_number == ticket_number,
                EventInvitation.status != "revoked",
            )
            .values(
                status="checked_in",
                checked_in_at=func.coalesce(EventInvitation.checked_in_at, now),
                updated_at=now,
            )
        )
    res = await db.execute(stmt)
    await db.commit()
    return _ok({"updated": int(res.rowcount or 0)})


# ═════════════════════════════════════════════════════════════════════════════
# 3) 초대권 발송 큐 (드레인 워커 전용)
# ═════════════════════════════════════════════════════════════════════════════


class DispatchClaimIn(BaseModel):
    claim_token: uuid.UUID
    limit: int = Field(100, ge=1, le=_MAX_CLAIM_LIMIT)
    lease_minutes: int = Field(5, ge=1, le=120)


class DispatchRequeueIn(BaseModel):
    claim_token: uuid.UUID
    dispatch_ids: list[uuid.UUID] = Field(default_factory=list)


class DispatchCompleteIn(BaseModel):
    claim_token: uuid.UUID
    dispatch_ids: list[uuid.UUID] = Field(default_factory=list)
    invitation_ids: list[uuid.UUID] = Field(default_factory=list)
    sent: bool
    request_id: str | None = Field(None, max_length=100)
    error: str | None = Field(None, max_length=500)


@router.post("/invitation-dispatch/claim")
async def claim_dispatch(body: DispatchClaimIn, db: AsyncSession = Depends(get_db)):
    """배치 클레임(리스). `queued` + **리스 만료된 `sending`** 을 선점한다.

    동시 2회 실행: 조건부 UPDATE 가 같은 행에서 직렬화되고, 진 쪽은 갱신 0행 → 그 행을
    돌려받지 못한다(SKIP LOCKED 는 처리량 최적화일 뿐 정확성 근거가 아니다).
    응답에는 원장 필드(ticket_number·admission_day·token_version·send_epoch)를 함께 실어
    워커가 두 번째 조회를 하지 않게 한다.
    """
    now = _now()
    stale = _dispatch_claim_stale_sql(now)
    candidate_ids = list(
        (
            await db.execute(
                select(InvitationDispatch.id)
                .where(stale)
                .order_by(InvitationDispatch.created_at.asc())
                .limit(body.limit)
            )
        )
        .scalars()
        .all()
    )
    if not candidate_ids:
        return _ok({"items": []})

    await db.execute(
        update(InvitationDispatch)
        .where(InvitationDispatch.id.in_(candidate_ids), stale)
        .values(
            status="sending",
            claim_token=body.claim_token,
            claim_expires_at=now + timedelta(minutes=body.lease_minutes),
            attempt_count=InvitationDispatch.attempt_count + 1,
            updated_at=now,
        )
    )
    await db.commit()

    rows = (
        await db.execute(
            select(InvitationDispatch, EventInvitation)
            .join(EventInvitation, EventInvitation.id == InvitationDispatch.invitation_id)
            .where(InvitationDispatch.claim_token == body.claim_token)
            .order_by(InvitationDispatch.created_at.asc())
        )
    ).all()

    items = [
        {
            "dispatch_id": str(d.id),
            "invitation_id": str(d.invitation_id),
            "event_id": str(d.event_id),
            # 🔴 발송 대상의 정본은 **초대권**이지 발송 큐 스냅샷이 아니다 (2026-08-12).
            #    양도(:1276)는 초대권의 주인을 바꾸지만 `invitation_dispatch` 는 안 고친다.
            #    그런데 종전엔 여기서 `d.phone` 을 내려보내, 양도 뒤 재발송이 **옛 주인에게**
            #    갔다 — 실측: 08-11 09:19 배치 10건 중 7건이 옛 주인 번호로 발송됐고
            #    받을 사람 셋(서범원·최보근·김연수)은 끝내 못 받았다.
            #    ⚠️ 스냅샷을 갱신하는 것만으로는 부족하다. 갱신을 빠뜨리는 경로가 또 생긴다.
            #       **읽는 쪽이 정본을 보게** 해야 양도가 몇 번 일어나도 안전하다.
            "phone": inv.phone_display or inv.phone_normalized,
            "recipient_name": inv.recipient_name,
            # 진단용 — 스냅샷이 낡았음을 남긴다. 🔴 **차단하지 않는다**:
            # 여기서 막으면 대회 중 발송이 통째로 멈춘다.
            "snapshot_stale": (d.phone != (inv.phone_display or inv.phone_normalized)),
            "send_epoch": int(d.send_epoch),
            "attempt_count": int(d.attempt_count),
            "ticket_number": inv.ticket_number,
            "admission_day": _ymd(inv.admission_day),
            "token_version": int(inv.token_version),
            "invitation_status": inv.status,
        }
        for d, inv in rows
    ]
    return _ok({"items": items})


@router.post("/invitation-dispatch/requeue")
async def requeue_dispatch(body: DispatchRequeueIn, db: AsyncSession = Depends(get_db)):
    """발송 불가분(티켓번호 미확정·행사정보 조회실패) 재큐잉. 리스 소유자만.

    발송 자체를 하지 않은 항목이므로 `send_epoch` 는 올리지 않는다(다음 tick 이 같은
    멱등키로 처음 발송한다).
    """
    if not body.dispatch_ids:
        return _ok({"requeued": 0})
    now = _now()
    res = await db.execute(
        update(InvitationDispatch)
        .where(
            InvitationDispatch.id.in_(body.dispatch_ids),
            InvitationDispatch.claim_token == body.claim_token,
        )
        .values(
            status="queued", claim_token=None, claim_expires_at=None, updated_at=now
        )
    )
    await db.commit()
    return _ok({"requeued": int(res.rowcount or 0)})


@router.post("/invitation-dispatch/complete")
async def complete_dispatch(body: DispatchCompleteIn, db: AsyncSession = Depends(get_db)):
    """발송 결과 반영. **리스 토큰이 아직 자기 것일 때만** 반영(늦은 워커 덮어쓰기 차단)."""
    now = _now()
    updated = 0
    if body.dispatch_ids:
        if body.sent:
            stmt = (
                update(InvitationDispatch)
                .where(
                    InvitationDispatch.id.in_(body.dispatch_ids),
                    InvitationDispatch.claim_token == body.claim_token,
                )
                .values(
                    status="sent",
                    request_id=body.request_id,
                    last_error=None,
                    updated_at=now,
                )
            )
        else:
            stmt = (
                update(InvitationDispatch)
                .where(
                    InvitationDispatch.id.in_(body.dispatch_ids),
                    InvitationDispatch.claim_token == body.claim_token,
                )
                .values(
                    status="failed",
                    last_error=body.error or "알림톡 배치 발송 실패",
                    updated_at=now,
                )
            )
        updated = int((await db.execute(stmt)).rowcount or 0)

    if body.invitation_ids:
        if body.sent:
            await db.execute(
                update(EventInvitation)
                .where(
                    EventInvitation.id.in_(body.invitation_ids),
                    EventInvitation.status == "issued",
                )
                .values(status="sent", sent_at=now, updated_at=now)
            )
        else:
            await db.execute(
                update(EventInvitation)
                .where(
                    EventInvitation.id.in_(body.invitation_ids),
                    EventInvitation.status == "issued",
                )
                .values(
                    status="failed", failure_reason="알림톡 발송 실패", updated_at=now
                )
            )
    await db.commit()
    return _ok({"updated": updated})


# ── 🔴 전달 상태 대사 — "접수됨"과 "도달함"은 다른 사실이다 ──────────────────
#
# 실측(2026-07-28, 실계정 발송): 버튼 링크가 승인 템플릿과 어긋난 발송이
#   requestStatusCode = "A000"  (접수 성공 — 워커가 보던 유일한 값)
#   messageStatusCode  = "3027" (전달 실패, "버튼 내용이 템플릿과 불일치")
# 로 돌아왔다. 즉 **카톡이 도착하지 않았는데 원장에는 status='sent'** 로 남았고,
# 주최자 화면에도 발송 완료로 떴다. 대회 당일이면 수백 명이 초대권을 못 받은 채
# 아무도 모른다.
#
# 도달 여부는 발송 직후엔 알 수 없고 몇 초 뒤 SENS 조회로만 보인다. 그래서 워커가
# 나중에 확인하고 그 결과를 여기로 돌려준다. 확인 전에는 `delivery_checked_at IS NULL`.

# 대사 유예 — 발송 직후 조회하면 SENS 가 아직 전달결과를 모른다(코드 없음 → 미도달로
# 오판). 이 시간이 지난 건만 대사 후보로 넘긴다.
_DELIVERY_CHECK_GRACE = timedelta(seconds=60)
# 대사 포기 시한 — 이 시간이 지나도록 결과가 안 잡히면 계속 훑지 않는다(무한 후보 방지).
# 포기 시점의 판단은 워커가 한다(여기서는 후보에서 빼지 않는다 — 운영자가 볼 수 있게 남긴다).
_DELIVERY_CHECK_WINDOW = timedelta(hours=48)


@router.get("/invitation-dispatch/pending-delivery-check")
async def pending_delivery_check(
    limit: int = Query(200, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """도달 확인이 안 된 발송 목록. 워커가 SENS 에 조회해 결과를 돌려준다.

    후보 = `status='sent'` + `request_id` 있음 + `delivery_checked_at IS NULL`
           + 발송 후 유예시간 경과 + 대사 시한 내.
    """
    now = _now()
    rows = (
        (
            await db.execute(
                select(InvitationDispatch)
                .where(
                    InvitationDispatch.status == "sent",
                    InvitationDispatch.request_id.isnot(None),
                    InvitationDispatch.delivery_checked_at.is_(None),
                    InvitationDispatch.updated_at < now - _DELIVERY_CHECK_GRACE,
                    InvitationDispatch.updated_at > now - _DELIVERY_CHECK_WINDOW,
                )
                .order_by(InvitationDispatch.updated_at.asc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return _ok(
        {
            "items": [
                {
                    "dispatch_id": str(r.id),
                    "invitation_id": str(r.invitation_id),
                    "request_id": r.request_id,
                    "phone": r.phone,
                }
                for r in rows
            ]
        }
    )


class DeliveryCheckItem(BaseModel):
    dispatch_id: uuid.UUID
    invitation_id: uuid.UUID
    delivered: bool
    code: str | None = Field(None, max_length=32)
    desc: str | None = Field(None, max_length=300)


class DeliveryResultIn(BaseModel):
    checked: list[DeliveryCheckItem] = Field(default_factory=list, max_length=500)


@router.post("/invitation-dispatch/delivery-result")
async def delivery_result(body: DeliveryResultIn, db: AsyncSession = Depends(get_db)):
    """대사 결과 반영.

    도달 → `delivery_checked_at` 만 기록(상태 불변, 재조회 대상에서 빠진다).
    미도달 → `status='failed'` + 사유 기록 + 초대 원장도 failed 로 되돌린다.
             **여기가 없으면 미도달이 영구히 '발송됨'으로 남는다.**

    멱등: `delivery_checked_at IS NULL` 인 행만 갱신한다(중복 호출·동시 2회 안전).
    """
    now = _now()
    delivered_ids = [c.dispatch_id for c in body.checked if c.delivered]
    failed = [c for c in body.checked if not c.delivered]
    marked = 0

    if delivered_ids:
        marked += int(
            (
                await db.execute(
                    update(InvitationDispatch)
                    .where(
                        InvitationDispatch.id.in_(delivered_ids),
                        InvitationDispatch.delivery_checked_at.is_(None),
                    )
                    .values(delivery_checked_at=now, updated_at=now)
                )
            ).rowcount
            or 0
        )

    for c in failed:
        reason = f"알림톡 미도달({c.code or '-'}): {c.desc or ''}".strip()
        res = await db.execute(
            update(InvitationDispatch)
            .where(
                InvitationDispatch.id == c.dispatch_id,
                InvitationDispatch.delivery_checked_at.is_(None),
            )
            .values(
                status="failed",
                last_error=reason[:500],
                delivery_checked_at=now,
                updated_at=now,
            )
        )
        if int(res.rowcount or 0) == 0:
            continue  # 이미 대사됨 — 초대 원장도 건드리지 않는다(멱등).
        marked += 1
        # 초대 원장 되돌림 — 화면·재발송 판단의 정본이다. 이미 열람/입장한 건은
        # 손대지 않는다(도달 실패 판정이 늦게 와도 실제 사용 기록이 우선).
        await db.execute(
            update(EventInvitation)
            .where(
                EventInvitation.id == c.invitation_id,
                EventInvitation.status == "sent",
            )
            .values(status="failed", failure_reason=reason[:300], updated_at=now)
        )

    await db.commit()
    return _ok({"marked": marked, "undelivered": len(failed)})


# ═════════════════════════════════════════════════════════════════════════════
# 4) 좌석 알림(찜)
# ═════════════════════════════════════════════════════════════════════════════


class SeatWatchIn(BaseModel):
    seat_id: uuid.UUID
    user_id: uuid.UUID | None = None
    session_id: str | None = Field(None, max_length=64)
    account_ref: str | None = Field(None, max_length=64)
    target_price: int | None = Field(None, ge=0)


def _serialize_watch(row: SeatWatch) -> dict:
    return {
        "id": str(row.id),
        "event_id": str(row.event_id),
        "seat_id": str(row.seat_id),
        "target_price": int(row.target_price) if row.target_price is not None else None,
        "notify_at": _iso(row.notify_at),
        "created_at": _iso(row.created_at),
    }


def _watch_owner_filter(user_id: uuid.UUID | None, session_id: str | None):
    if user_id is not None:
        return SeatWatch.user_id == user_id
    if session_id:
        return SeatWatch.session_id == session_id
    raise ApiError(
        "VALIDATION_ERROR", "user_id or session_id required", 400, "owner"
    )


@router.get("/events/{event_id}/seat-watches")
async def list_seat_watches(
    event_id: uuid.UUID,
    user_id: uuid.UUID | None = Query(None),
    session_id: str | None = Query(None, max_length=64),
    limit: int = Query(100, ge=1, le=_MAX_LIST_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    try:
        owner = _watch_owner_filter(user_id, session_id)
        rows = list(
            (
                await db.execute(
                    select(SeatWatch)
                    .where(SeatWatch.event_id == event_id, owner)
                    .order_by(SeatWatch.created_at.desc())
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return _ok({"watches": [_serialize_watch(r) for r in rows]})
    except ApiError as e:
        return _err(e)


@router.post("/events/{event_id}/seat-watches")
async def upsert_seat_watch(
    event_id: uuid.UUID,
    body: SeatWatchIn,
    db: AsyncSession = Depends(get_db),
):
    """찜 등록/갱신(upsert). 같은 소유자·같은 좌석은 target_price 만 갱신한다."""
    try:
        owner = _watch_owner_filter(body.user_id, body.session_id)
        exists = (
            await db.execute(select(Event.id).where(Event.id == event_id))
        ).scalar_one_or_none()
        if exists is None:
            raise ApiError("EVENT_NOT_FOUND", "event not found", 404, "event_id")

        async def _existing() -> SeatWatch | None:
            return (
                await db.execute(
                    select(SeatWatch).where(SeatWatch.seat_id == body.seat_id, owner)
                )
            ).scalar_one_or_none()

        now = _now()
        prior = await _existing()
        if prior is not None:
            prior.target_price = body.target_price
            prior.updated_at = now
            await db.commit()
            await db.refresh(prior)
            return _ok({"watch": _serialize_watch(prior)}, replay=True)

        row = SeatWatch(
            event_id=event_id,
            seat_id=body.seat_id,
            user_id=body.user_id,
            session_id=body.session_id,
            account_ref=body.account_ref,
            target_price=body.target_price,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            winner = await _existing()
            if winner is None:
                raise ApiError("CONFLICT", "seat watch conflict", 409, "seat_id") from None
            winner.target_price = body.target_price
            winner.updated_at = now
            await db.commit()
            await db.refresh(winner)
            return _ok({"watch": _serialize_watch(winner)}, replay=True)
        await db.refresh(row)
        return _ok({"watch": _serialize_watch(row)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.delete("/events/{event_id}/seat-watches")
async def delete_seat_watch(
    event_id: uuid.UUID,
    seat_id: uuid.UUID = Query(...),
    user_id: uuid.UUID | None = Query(None),
    session_id: str | None = Query(None, max_length=64),
    db: AsyncSession = Depends(get_db),
):
    try:
        owner = _watch_owner_filter(user_id, session_id)
        res = await db.execute(
            delete(SeatWatch).where(
                SeatWatch.event_id == event_id, SeatWatch.seat_id == seat_id, owner
            )
        )
        await db.commit()
        return _ok({"deleted": int(res.rowcount or 0)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.get("/seat-watches/pending")
async def pending_seat_watches(
    limit: int = Query(200, ge=1, le=_MAX_LIST_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """미발송(notify_at IS NULL) 후보. cron 전용 — 판정은 호출자가 v2 좌석/티어로 한다."""
    rows = list(
        (
            await db.execute(
                select(SeatWatch)
                .where(SeatWatch.notify_at.is_(None))
                .order_by(SeatWatch.created_at.asc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return _ok(
        {
            "watches": [
                {
                    "id": str(r.id),
                    "event_id": str(r.event_id),
                    "seat_id": str(r.seat_id),
                    "account_ref": r.account_ref,
                    "session_id": r.session_id,
                    "target_price": int(r.target_price)
                    if r.target_price is not None
                    else None,
                }
                for r in rows
            ]
        }
    )


@router.post("/seat-watches/{watch_id}/claim")
async def claim_seat_watch(watch_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """발송 선점 — `notify_at IS NULL` 조건부 UPDATE. 1행을 갱신한 실행만 발송한다."""
    now = _now()
    res = await db.execute(
        update(SeatWatch)
        .where(SeatWatch.id == watch_id, SeatWatch.notify_at.is_(None))
        .values(notify_at=now, updated_at=now)
    )
    await db.commit()
    return _ok({"claimed": int(res.rowcount or 0) > 0})


@router.post("/seat-watches/{watch_id}/release")
async def release_seat_watch(watch_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """선점 해제(발송 실패 복구) — 되돌리지 않으면 알림이 영구 유실된다."""
    now = _now()
    res = await db.execute(
        update(SeatWatch)
        .where(SeatWatch.id == watch_id)
        .values(notify_at=None, updated_at=now)
    )
    await db.commit()
    return _ok({"released": int(res.rowcount or 0) > 0})


# ═════════════════════════════════════════════════════════════════════════════
# 5) 현장 체크인 명단 / 로그
# ═════════════════════════════════════════════════════════════════════════════


class CheckInListIn(BaseModel):
    organizer_ref: OrganizerRef
    name: str = Field(..., min_length=1, max_length=200)
    product_ids: list[uuid.UUID] = Field(default_factory=list)
    opens_at: datetime | None = None
    closes_at: datetime | None = None
    status: str | None = Field(None, pattern="^(draft|active|closed)$")


class CheckInListPatch(BaseModel):
    organizer_ref: OrganizerRef
    name: str | None = Field(None, min_length=1, max_length=200)
    product_ids: list[uuid.UUID] | None = None
    opens_at: datetime | None = None
    closes_at: datetime | None = None
    status: str | None = Field(None, pattern="^(draft|active|closed)$")


class CheckInLogIn(BaseModel):
    organizer_ref: OrganizerRef
    ticket_id: uuid.UUID
    attended_date: date_cls
    check_in_list_id: uuid.UUID | None = None
    attendee_name: str | None = Field(None, max_length=200)
    ticket_number: str | None = Field(None, max_length=64)
    checked_in_by_ref: str | None = Field(None, max_length=64)
    method: str = Field("qr", pattern="^(qr|manual|search|offline)$")
    note: str | None = None


def _serialize_list(row: CheckInList) -> dict:
    return {
        "id": str(row.id),
        "name": row.name,
        "status": row.status,
        "product_ids": [str(p) for p in (row.product_ids or [])],
        "opens_at": _iso(row.opens_at),
        "closes_at": _iso(row.closes_at),
        "created_at": _iso(row.created_at),
    }


@router.get("/events/{event_id}/check-in-lists")
async def list_check_in_lists(
    event_id: uuid.UUID,
    organizer_ref: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    try:
        await _event_owner_guard(db, event_id, _parse_ref(organizer_ref))
        rows = list(
            (
                await db.execute(
                    select(CheckInList)
                    .where(CheckInList.event_id == event_id)
                    .order_by(CheckInList.created_at.desc())
                )
            )
            .scalars()
            .all()
        )
        return _ok({"lists": [_serialize_list(r) for r in rows]})
    except ApiError as e:
        return _err(e)


@router.get("/events/{event_id}/check-in-lists/{list_id}")
async def get_check_in_list(
    event_id: uuid.UUID,
    list_id: uuid.UUID,
    organizer_ref: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """단건 — 체크인 게이트가 `status`·`product_ids` 를 검증할 때 쓴다."""
    try:
        await _event_owner_guard(db, event_id, _parse_ref(organizer_ref))
        row = (
            await db.execute(
                select(CheckInList).where(
                    CheckInList.id == list_id, CheckInList.event_id == event_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("LIST_NOT_FOUND", "check-in list not found", 404, "list_id")
        return _ok({"list": _serialize_list(row)})
    except ApiError as e:
        return _err(e)


@router.post("/events/{event_id}/check-in-lists")
async def create_check_in_list(
    event_id: uuid.UUID,
    body: CheckInListIn,
    db: AsyncSession = Depends(get_db),
):
    try:
        organizer_id = await _event_owner_guard(db, event_id, body.organizer_ref)
        now = _now()
        row = CheckInList(
            event_id=event_id,
            organizer_id=organizer_id,
            name=body.name,
            status=body.status or "active",
            product_ids=[str(p) for p in body.product_ids],
            opens_at=body.opens_at,
            closes_at=body.closes_at,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return _ok({"list": _serialize_list(row)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.patch("/events/{event_id}/check-in-lists/{list_id}")
async def patch_check_in_list(
    event_id: uuid.UUID,
    list_id: uuid.UUID,
    body: CheckInListPatch,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _event_owner_guard(db, event_id, body.organizer_ref)
        row = (
            await db.execute(
                select(CheckInList).where(
                    CheckInList.id == list_id, CheckInList.event_id == event_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("LIST_NOT_FOUND", "check-in list not found", 404, "list_id")
        if body.name is not None:
            row.name = body.name
        if body.product_ids is not None:
            row.product_ids = [str(p) for p in body.product_ids]
        if body.opens_at is not None:
            row.opens_at = body.opens_at
        if body.closes_at is not None:
            row.closes_at = body.closes_at
        if body.status is not None:
            row.status = body.status
        row.updated_at = _now()
        await db.commit()
        await db.refresh(row)
        return _ok({"list": _serialize_list(row)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.delete("/events/{event_id}/check-in-lists/{list_id}")
async def delete_check_in_list(
    event_id: uuid.UUID,
    list_id: uuid.UUID,
    organizer_ref: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    try:
        await _event_owner_guard(db, event_id, _parse_ref(organizer_ref))
        res = await db.execute(
            delete(CheckInList).where(
                CheckInList.id == list_id, CheckInList.event_id == event_id
            )
        )
        await db.commit()
        if int(res.rowcount or 0) == 0:
            raise ApiError("LIST_NOT_FOUND", "check-in list not found", 404, "list_id")
        return _ok({"deleted": True})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.get("/events/{event_id}/check-in-logs")
async def list_check_in_logs(
    event_id: uuid.UUID,
    organizer_ref: str = Query(...),
    check_in_list_id: uuid.UUID | None = Query(None),
    ticket_id: uuid.UUID | None = Query(None),
    limit: int = Query(50, ge=1, le=_MAX_LOG_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """로그 목록. 명단명(`list_name`)은 LEFT JOIN 으로 함께 준다(go CSV/위젯 계약 보존)."""
    try:
        await _event_owner_guard(db, event_id, _parse_ref(organizer_ref))
        stmt = (
            select(CheckInLog, CheckInList.name)
            .outerjoin(CheckInList, CheckInList.id == CheckInLog.check_in_list_id)
            .where(CheckInLog.event_id == event_id)
        )
        if check_in_list_id is not None:
            stmt = stmt.where(CheckInLog.check_in_list_id == check_in_list_id)
        if ticket_id is not None:
            stmt = stmt.where(CheckInLog.ticket_id == ticket_id)
        stmt = stmt.order_by(CheckInLog.created_at.desc()).limit(limit)
        rows = (await db.execute(stmt)).all()
        return _ok(
            {
                "logs": [
                    {
                        "id": str(log.id),
                        "ticket_id": str(log.ticket_id),
                        "attendee_name": log.attendee_name,
                        "ticket_number": log.ticket_number,
                        "method": log.method,
                        "note": log.note,
                        "attended_date": _ymd(log.attended_date),
                        "list_name": list_name,
                        "created_at": _iso(log.created_at),
                    }
                    for log, list_name in rows
                ]
            }
        )
    except ApiError as e:
        return _err(e)


@router.post("/events/{event_id}/check-in-logs")
async def record_check_in_log(
    event_id: uuid.UUID,
    body: CheckInLogIn,
    db: AsyncSession = Depends(get_db),
):
    """로그 기록(멱등). UNIQUE(ticket_id, attended_date) 로 하루 1행을 집행한다.

    이미 있으면 `created=false` 로 기존 행을 재생한다 — 입장은 성공했는데 로그 기록만
    실패한 경우, 다음 스캔(v2 `already=true` 경로)이 같은 키로 **복구**할 수 있다.
    """
    try:
        organizer_id = await _event_owner_guard(db, event_id, body.organizer_ref)

        async def _existing() -> CheckInLog | None:
            return (
                await db.execute(
                    select(CheckInLog).where(
                        CheckInLog.ticket_id == body.ticket_id,
                        CheckInLog.attended_date == body.attended_date,
                    )
                )
            ).scalar_one_or_none()

        prior = await _existing()
        if prior is not None:
            return _ok({"created": False, "id": str(prior.id)}, replay=True)

        now = _now()
        row = CheckInLog(
            event_id=event_id,
            organizer_id=organizer_id,
            check_in_list_id=body.check_in_list_id,
            ticket_id=body.ticket_id,
            attendee_name=body.attendee_name,
            ticket_number=body.ticket_number,
            checked_in_by_ref=body.checked_in_by_ref,
            method=body.method,
            note=body.note,
            attended_date=body.attended_date,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            winner = await _existing()
            if winner is None:
                raise ApiError("CONFLICT", "check-in log conflict", 409, "ticket_id") from None
            return _ok({"created": False, "id": str(winner.id)}, replay=True)
        await db.refresh(row)
        return _ok({"created": True, "id": str(row.id)})
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.delete("/events/{event_id}/check-in-logs")
async def delete_check_in_logs(
    event_id: uuid.UUID,
    organizer_ref: str = Query(...),
    ticket_id: uuid.UUID = Query(...),
    attended_date: date_cls = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """입장 취소 원복 — 해당 (티켓, 입장일) 로그 삭제. 정본은 v2 입장 원장의 취소다."""
    try:
        await _event_owner_guard(db, event_id, _parse_ref(organizer_ref))
        res = await db.execute(
            delete(CheckInLog).where(
                CheckInLog.event_id == event_id,
                CheckInLog.ticket_id == ticket_id,
                CheckInLog.attended_date == attended_date,
            )
        )
        await db.commit()
        return _ok({"deleted": int(res.rowcount or 0)})
    except ApiError as e:
        await db.rollback()
        return _err(e)
