"""레벨2 컷오버 W5-ATTENDEE — go 참석자 **부속 원장** 6종의 v2 이관.

W4-ORD 가 참석자 *본체*(go `attendees`)를 v2 `tickets` 로 옮겼다. 남은 것은 그 주변을 돌던
go-local 부속 원장들이다. 대표 결정(2026-07-27) "A·B·C 다 살려서 간다" 에 따라 **하나도
폐기하지 않고** 전부 v2 에 자리를 만들어 옮긴다.

| go 테이블            | v2 모델            | 성격                                        |
|----------------------|--------------------|---------------------------------------------|
| `event_questions`    | EventQuestion      | 예매 설문 **문항 정의**(응답은 `tickets.answers`) |
| `event_invitations`  | EventInvitation    | 초대권 발급·추적 원장(실발송 경로)           |
| `invitation_dispatch`| InvitationDispatch | 초대권 알림톡 발송 큐(claim-lease)           |
| `seat_watches`       | SeatWatch          | 좌석 알림(찜) 등록 원장                       |
| `check_in_lists`     | CheckInList        | 현장 체크인 명단 정의                         |
| `check_in_logs`      | CheckInLog         | 현장 체크인 감사 원장                         |

## 테넌트 축 변환
go `account_id` → v2 `organizer_id`(= `users.id` = `events.organizer_id` 와 같은 축).
행에 denormalize 해 두되, **경계 집행의 정본은 `events.organizer_id` 조회**다(라우터의
`_event_owner_guard`). 두 값이 어긋나도 조회는 이벤트 소유로 막힌다.

## ID 보존
`event_questions.id` 는 **go 의 UUID 를 그대로 승계**할 수 있어야 한다. 이미 발권된 티켓의
`tickets.answers` 가 `{question_id: value}` 로 키잉돼 있기 때문이다(T2-ORD 흡수분).
그래서 서버 기본값에 의존하지 않고 호출자가 넘긴 id 를 그대로 쓴다.

## 설문 문항 삭제 = soft delete (`archived_at`)
go 는 `DELETE FROM event_questions` 였다. 그러면 이미 수집된 `tickets.answers` 의 그 키는
**라벨을 잃어** 참석자 상세에서 통째로 사라진다(응답 데이터는 남는데 보이지 않는 무성 손실).
v2 에서는 `archived_at` 으로 감춘다 — 주최자 폼에서는 사라지고, 응답 해석
(`include_archived=true`)에서는 라벨이 계속 살아 있다.

## 멱등성 설계 (발송·체크인 계열)
· `event_invitations` UNIQUE(event_id, phone_normalized, seq) — 같은 번호에 최대 5장(순번).
  ⚠️ 2026-07-30 변경. 종전 UNIQUE(event_id, phone_normalized) = 1인 1장 강제였다.
  "동시 2회 실행하면?" → 두 번째 INSERT 가 유니크 위반 → 라우터가 잡아 `created=false` 로
  기존 행을 재생한다. 발권(v2 주문 생성)은 `created=true` 인 쪽에서만 일어난다.
· `invitation_dispatch` UNIQUE(invitation_id) — 초대 1건당 큐 항목 1개. 이중 적재 불가.
· `invitation_dispatch.send_epoch` — **안정 멱등키 시드**(신설). 옛 go 드레인은 NCP 배치
  멱등키를 매 tick `randomUUID()` 인 claim_token 에서 만들었다. 발송 성공 후 결과 반영 전에
  crash 하면 리스 만료 후 **다른 claim_token 으로 재클레임** → 다른 멱등키 → **같은 사람에게
  알림톡 2통**. epoch 는 클레임으로는 변하지 않고 "의도적 재발송"에서만 증가하므로,
  crash 재시도는 같은 키(=NCP 가 dedup)로, 주최자의 재발송은 새 키(=실제로 발송)로 간다.
· `check_in_logs` UNIQUE(ticket_id, attended_date) — 티켓 1장은 하루 1행. v2 입장 원장
  (`event_admissions`)이 이미 하루 1회로 직렬화하므로 이 유니크는 그 불변식의 사본이고,
  덕분에 로그 기록을 **재시도 가능한 멱등 연산**으로 만들 수 있다(입장은 성공했는데 로그만
  실패한 경우, 다음 스캔이 같은 키로 복구한다).
"""

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# PG 는 JSONB, 테스트(SQLite)는 JSON — 리포 전역 관례.
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")

# 🔴 같은 번호에 발급 가능한 초대권 최대 장수 (2026-08-09: 5 → **50**, 발주처 요청).
#    이 값은 DB CHECK 제약으로도 굳는다 — 바꾸면 **마이그레이션이 필요**하다.
#    상한이 존재하는 3곳: 이 상수(+CHECK) · 예약 엔드포인트(409 LIMIT) · go 폭주 방어선.
#
#    ⚠️ **되돌릴 수 없다.** 6장 이상 발급된 번호가 하나라도 생기면 5 로 되돌리는
#       마이그레이션은 CHECK 위반으로 실패한다(inv50_0809 의 downgrade 참조).
#    ⚠️ go 에 이 숫자를 **복제하지 않는다**. 호출자가 세면 동시 요청에 뚫린다 —
#       go 는 409 INVITATION_LIMIT 을 종료조건으로만 쓴다.
#    (EventInvitation docstring 의 "트레이드오프" 절 참조)
INVITATION_MAX_PER_PHONE = 50


QUESTION_TYPES = (
    "short_text",
    "long_text",
    "single_choice",
    "multiple_choice",
    "checkbox",
)

INVITATION_STATUSES = ("issued", "sent", "failed", "viewed", "checked_in", "revoked")
DISPATCH_STATUSES = ("queued", "sending", "sent", "failed")
CHECK_IN_LIST_STATUSES = ("draft", "active", "closed")
CHECK_IN_METHODS = ("qr", "manual", "search", "offline")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── 1) 예매 설문 문항 정의 ────────────────────────────────────────────────────


class EventQuestion(Base):
    """예매 설문 **문항 정의**(go `event_questions` 이관).

    응답은 여기가 아니라 `tickets.answers`(JSONB, T2-ORD 흡수)에 `{str(question_id): value}`
    로 저장된다. 그래서 이 테이블의 `id` 는 **go 의 UUID 를 승계**해야 하고, 삭제도 물리
    삭제가 아니라 `archived_at` 이어야 한다(위 모듈 도크 참조).
    """

    __tablename__ = "event_questions"
    __table_args__ = (
        CheckConstraint(
            "question_type IN ('short_text','long_text','single_choice',"
            "'multiple_choice','checkbox')",
            name="ck_event_questions_type",
        ),
        Index("idx_event_questions_event_sort", "event_id", "sort_order"),
        Index("idx_event_questions_organizer", "organizer_id"),
    )

    # 서버 기본값 없이 애플리케이션이 넘긴 값을 그대로 쓴다(go id 승계 경로).
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    label: Mapped[str] = mapped_column(Text, nullable=False)
    question_type: Mapped[str] = mapped_column(String(30), nullable=False)
    is_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    options: Mapped[list] = mapped_column(_JSON_TYPE, nullable=False, default=list)
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # soft delete — 응답 라벨 해석을 살려두기 위해 물리 삭제하지 않는다.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


# ── 2) 초대권 발급·추적 원장 ──────────────────────────────────────────────────


class EventInvitation(Base):
    """초대권(comp) 발급·추적 원장 (go `event_invitations` 이관).

    상태머신: issued → (sent|failed) → viewed → checked_in / (언제든) revoked.

    ## 🔴 UNIQUE(event_id, phone_normalized, **seq**) — 1인 다장 (2026-07-30)

    대회 요건: **1인당 최대 5장**. 받은 사람이 친구와 같이 오거나 선물해 나눈다.
    종전 `UNIQUE(event_id, phone_normalized)` 는 **1인 1장을 DB로 강제**해 요건 불가였다.

    ⚠️ 그 제약은 단순 중복 방지가 아니라 **락 역할을 겸하고 있었다**
       (CSV 내부 중복 · 재업로드 · 동시 2회 실행을 한 지점에서 흡수).
       그래서 **지우지 않고 순번을 추가**했다 — 한도만 1 → `INVITATION_MAX_PER_PHONE` 로 열고
       같은 `(event, phone, seq)` 는 여전히 하나이므로 **동시성 방어가 유지된다**.

    ### 왜 앱 카운트가 아니라 DB 제약인가
    "제약 제거 + 앱에서 발급수 세기" 를 검토했으나 **동시 요청에 상한이 뚫린다**
    (둘이 동시에 4장을 세고 각각 발급 → 6장). 상한은 DB만이 원자적으로 집행한다.

    ### ⚠️ 상한 숫자가 **3곳**에 존재한다 (의도된 트레이드오프, 부채로 기록)
      1. 이 파일의 `CHECK (seq BETWEEN 1 AND 5)`
      2. `app/api/v1/internal_attendee_ledger.py` 예약 엔드포인트(409 LIMIT 판정)
      3. go 화면 안내 문구
    이벤트별 상한으로 바꾸려면 **CHECK 를 버리는 마이그레이션이 다시 필요**하고,
    DB 상한을 포기하면 위 "앱 카운트" 문제로 되돌아간다. 대회 특정 요건이라
    지금은 하드코딩이 옳다고 판단했다 — 다음 런칭에서 재검토할 것.
    """

    __tablename__ = "event_invitations"
    __table_args__ = (
        CheckConstraint(
            "status IN ('issued','sent','failed','viewed','checked_in','revoked')",
            name="ck_event_invitations_status",
        ),
        CheckConstraint("token_version >= 0", name="ck_event_invitations_token_version"),
        # 🔴 마지막 방어선 — 앱 검증을 우회해도 6장째는 DB가 거부한다.
        CheckConstraint(
            f"seq >= 1 AND seq <= {INVITATION_MAX_PER_PHONE}",
            name="ck_event_invitations_seq_range",
        ),
        UniqueConstraint(
            "event_id",
            "phone_normalized",
            "seq",
            name="uq_event_invitations_event_phone_seq",
        ),
        Index("idx_event_invitations_org_event", "organizer_id", "event_id", "status"),
        Index("idx_event_invitations_ticket_number", "ticket_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # 발권 결과 앵커. FK 를 걸지 않는다 — 티켓이 사라져도 "누구에게 초대장을 보냈는가"는
    # 남아야 하는 발송 이력이다(감사·재발송 판단 근거).
    ticket_number: Mapped[str | None] = mapped_column(String(64), nullable=True)

    recipient_name: Mapped[str] = mapped_column(String(200), nullable=False)
    phone_normalized: Mapped[str] = mapped_column(String(32), nullable=False)
    # 같은 번호에 발급된 초대권의 순번(1..INVITATION_MAX_PER_PHONE).
    # server_default="1" 이라 기존 행은 그대로 유효하다(마이그레이션 무손상).
    seq: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=1, server_default="1"
    )
    phone_display: Mapped[str] = mapped_column(String(64), nullable=False)
    admission_day: Mapped[date | None] = mapped_column(Date, nullable=True)
    admission_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # 딥링크 bearer revocation nonce — 회수 시 +1 → 이미 보낸 링크가 즉시 무효.
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="issued", server_default="issued"
    )
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    checked_in_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


class InvitationDispatch(Base):
    """초대권 알림톡 발송 큐 (go `invitation_dispatch` 이관).

    claim-lease 원장. 드레인 워커(go, NCP 자격 보유)가 `claim_token` 으로 배치를 선점하고,
    발송 후 **자기 토큰이 아직 유효할 때만** 결과를 반영한다(늦게 돌아온 이전 워커의 덮어쓰기
    차단). 리스 구조를 깨면 곧바로 중복 발송이므로 컬럼 의미를 go 원본과 1:1 로 보존한다.

    신설 `send_epoch`: 외부 발송 멱등키의 **안정 시드**. 클레임으로는 변하지 않고
    `resend`(주최자의 명시적 재발송)에서만 +1 한다. 모듈 도크의 "crash 후 2통" 결함 차단.
    """

    __tablename__ = "invitation_dispatch"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','sending','sent','failed')",
            name="ck_invitation_dispatch_status",
        ),
        CheckConstraint("attempt_count >= 0", name="ck_invitation_dispatch_attempt"),
        CheckConstraint("send_epoch >= 0", name="ck_invitation_dispatch_epoch"),
        UniqueConstraint("invitation_id", name="uq_invitation_dispatch_invitation"),
        Index("idx_invitation_dispatch_claim", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    invitation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("event_invitations.id", ondelete="CASCADE"),
        nullable=False,
    )
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    organizer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # 발송 시 실릴 값(적재 시점 스냅샷) — 재시도에도 같은 본문 보장.
    phone: Mapped[str] = mapped_column(String(64), nullable=False)
    recipient_name: Mapped[str] = mapped_column(String(200), nullable=False)

    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="queued", server_default="queued"
    )
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    send_epoch: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # 🔴 전달 상태 대사 시각. `status='sent'` 는 **접수 성공**일 뿐이고 카카오가 전달을
    #    거부했는지는 별도 조회로만 알 수 있다(실측 3027 — 접수 A000 인데 미도달).
    #    NULL = 아직 도달 확인 안 됨. 이 컬럼이 없으면 대사 대상을 매 tick 다시 훑는다.
    delivery_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    claim_token: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    claim_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


# ── 3) 좌석 알림(찜) ──────────────────────────────────────────────────────────


class SeatWatch(Base):
    """좌석 즐겨찾기 / 가격 알림 등록 (go `seat_watches` 이관).

    · `target_price` NULL = 단순 찜(좌석이 available 로 풀리면 알림)
    · `target_price` 값   = 가격이 그 이하로 내려오면 알림
    · `notify_at`         = 발송 선점 시각. NULL 인 것만 후보이며, 조건부 UPDATE 로
                            선점한 실행만 발송한다(동시 2회 tick 이중발송 차단).

    `seat_id` 에 FK 를 걸지 않는다 — 배치도 재생성으로 좌석 행이 갈리면 CASCADE 로 찜이
    조용히 사라진다. go 동작(좌석을 못 찾으면 그 tick 만 건너뛰고 찜은 유지)을 보존한다.
    `account_ref` 는 알림 라우팅용 go account 식별자로 문자열 보관(경계 집행에 쓰지 않는다).
    """

    __tablename__ = "seat_watches"
    __table_args__ = (
        CheckConstraint(
            "user_id IS NOT NULL OR session_id IS NOT NULL",
            name="ck_seat_watches_owner",
        ),
        Index(
            "uq_seat_watches_user_seat",
            "user_id",
            "seat_id",
            unique=True,
            postgresql_where=text("user_id IS NOT NULL"),
            sqlite_where=text("user_id IS NOT NULL"),
        ),
        Index(
            "uq_seat_watches_session_seat",
            "session_id",
            "seat_id",
            unique=True,
            postgresql_where=text("session_id IS NOT NULL"),
            sqlite_where=text("session_id IS NOT NULL"),
        ),
        Index("idx_seat_watches_event", "event_id"),
        Index(
            "idx_seat_watches_pending",
            "created_at",
            postgresql_where=text("notify_at IS NULL"),
            sqlite_where=text("notify_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    seat_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    account_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)

    target_price: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    notify_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


# ── 4) 현장 체크인 명단 · 로그 ────────────────────────────────────────────────


class CheckInList(Base):
    """현장 체크인 명단 정의 (go `check_in_lists` 이관).

    `product_ids` 는 **go product UUID 배열**이다(v2 tier 의 `external_ref`). 체크인 판정에서
    티켓의 `product_external_ref` 와 정확매칭한다 — 이관하면서 의미를 바꾸지 않는다.
    """

    __tablename__ = "check_in_lists"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft','active','closed')", name="ck_check_in_lists_status"
        ),
        Index("idx_check_in_lists_event", "event_id", "created_at"),
        Index("idx_check_in_lists_organizer", "organizer_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", server_default="active"
    )
    product_ids: Mapped[list] = mapped_column(_JSON_TYPE, nullable=False, default=list)
    opens_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closes_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


class CheckInLog(Base):
    """현장 체크인 감사 원장 (go `check_in_logs` 이관, mig247 의 v2 키잉을 그대로 승계).

    표시값(`attendee_name`·`ticket_number`)은 **기록 시점 스냅샷**이다 — CSV 한 장을 뽑으려고
    티켓 수만큼 재조회를 하지 않기 위한 의도적 비정규화(mig247 결정 유지).

    `ticket_id` 에 FK 를 걸지 않는다: 감사 원장은 대상 행이 사라져도 남아야 한다.
    UNIQUE(ticket_id, attended_date) 는 "티켓 1장 = 하루 1행" 불변식의 집행이며, 덕분에
    로그 기록이 **재시도 가능한 멱등 연산**이 된다(입장은 성공/로그만 실패 → 다음 스캔이 복구).
    """

    __tablename__ = "check_in_logs"
    __table_args__ = (
        CheckConstraint(
            "method IN ('qr','manual','search','offline')", name="ck_check_in_logs_method"
        ),
        UniqueConstraint(
            "ticket_id", "attended_date", name="uq_check_in_logs_ticket_day"
        ),
        Index("idx_check_in_logs_event_created", "event_id", "created_at"),
        Index("idx_check_in_logs_ticket", "ticket_id"),
        Index("idx_check_in_logs_organizer", "organizer_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    check_in_list_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("check_in_lists.id", ondelete="SET NULL"),
        nullable=True,
    )

    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    attendee_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    ticket_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 체크인 수행자 — go session.id(= v2 user id). FK 없이 문자열 보관(스태프 삭제에도 이력 보존).
    checked_in_by_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)

    method: Mapped[str] = mapped_column(
        String(20), nullable=False, default="qr", server_default="qr"
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    attended_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


__all__ = [
    "EventQuestion",
    "EventInvitation",
    "InvitationDispatch",
    "SeatWatch",
    "CheckInList",
    "CheckInLog",
    "QUESTION_TYPES",
    "INVITATION_STATUSES",
    "DISPATCH_STATUSES",
    "CHECK_IN_LIST_STATUSES",
    "CHECK_IN_METHODS",
]
