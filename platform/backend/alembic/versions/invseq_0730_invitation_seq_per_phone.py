"""초대권 1인 다장 — event_invitations 에 seq 도입 (UNIQUE 에 순번 추가)

🔴 왜 필요한가 (대회 요건, 2026-07-30)
   "초대권을 1인당 최대 5장까지 보내야 한다. 받은 사람이 친구들과 같이 오거나
    선물해서 나눠 쓴다."
   종전 `UNIQUE(event_id, phone_normalized)` 가 **1인 1장을 DB로 강제**해 불가였다.

⚠️ 그 제약은 단순 중복 방지가 아니라 **락 역할을 겸했다** — CSV 내부 중복 · 재업로드 ·
   동시 2회 실행을 예약 엔드포인트 한 지점에서 흡수하는 장치였다
   (`internal_attendee_ledger.py` 예약 라우트: "dedup·동시성의 유일한 집행 지점").
   그래서 **제약을 지우지 않고 순번을 추가**한다. 같은 `(event, phone, seq)` 는
   여전히 하나이므로 **동시성 방어가 유지되면서 한도만 1 → 5 로 열린다.**

### 왜 앱에서 카운트하지 않는가
"제약 제거 + 애플리케이션에서 발급수 세기" 를 검토했으나 **동시 요청에 상한이 뚫린다**
(두 요청이 동시에 4장을 세고 각각 발급 → 6장). 상한은 DB만 원자적으로 집행한다.

### ⚠️ 상한 숫자 5 가 3곳에 존재한다 (의도된 트레이드오프 — 부채로 기록)
  1. 이 마이그레이션의 `ck_event_invitations_seq_range`
  2. `app/models/go_attendee_ledger.py::INVITATION_MAX_PER_PHONE`
  3. 예약 엔드포인트(409 LIMIT) · go 화면 안내
이벤트별 상한으로 바꾸려면 **CHECK 를 버리는 마이그레이션이 다시 필요**하고,
DB 상한을 포기하면 위 "앱 카운트" 문제로 되돌아간다.

### 무손상 · 되돌리기
  · `seq` 는 `server_default='1'` → **기존 행이 그대로 유효**하다.
  · 🔴 **downgrade 는 다장 발급이 시작되기 전까지만 가능**하다. 같은 번호에 2장 이상이
    존재하면 옛 UNIQUE(event_id, phone) 복원이 실패한다 — 그때는 데이터 정리가 선행돼야 한다.
    downgrade 는 그 상황을 **조용히 넘기지 않고 명시적으로 실패**시킨다(아래 사전 점검).

Revision ID: invseq_0730
Revises: dlvchk_0728
Create Date: 2026-07-30
"""

from alembic import op
import sqlalchemy as sa

revision = "invseq_0730"
down_revision = "dlvchk_0728"
branch_labels = None
depends_on = None

MAX_PER_PHONE = 5


def upgrade() -> None:
    # 1) seq 컬럼 — 기존 행은 전부 1 (무손상).
    op.add_column(
        "event_invitations",
        sa.Column(
            "seq",
            sa.SmallInteger(),
            nullable=False,
            server_default="1",
        ),
    )

    # 2) 옛 유니크 제거 → 순번 포함 유니크. 순서가 중요하다(겹치는 동안 중복 삽입 불가).
    op.drop_constraint(
        "uq_event_invitations_event_phone", "event_invitations", type_="unique"
    )
    op.create_unique_constraint(
        "uq_event_invitations_event_phone_seq",
        "event_invitations",
        ["event_id", "phone_normalized", "seq"],
    )

    # 3) 🔴 마지막 방어선 — 앱 검증을 우회해도 6장째는 DB가 거부한다.
    op.create_check_constraint(
        "ck_event_invitations_seq_range",
        "event_invitations",
        f"seq >= 1 AND seq <= {MAX_PER_PHONE}",
    )


def downgrade() -> None:
    # 🔴 사전 점검 — 같은 (event, phone) 에 2장 이상이 있으면 옛 UNIQUE 를 복원할 수 없다.
    #    조용히 실패하면 "downgrade 됐다" 고 믿은 채 제약이 사라진 상태가 된다.
    conn = op.get_bind()
    dup = conn.execute(
        sa.text(
            """
            SELECT count(*) FROM (
              SELECT event_id, phone_normalized
              FROM event_invitations
              GROUP BY event_id, phone_normalized
              HAVING count(*) > 1
            ) d
            """
        )
    ).scalar()
    if dup:
        raise RuntimeError(
            f"downgrade 중단: 같은 (event_id, phone_normalized) 에 2장 이상인 조합이 {dup}건 있습니다. "
            "옛 UNIQUE(event_id, phone_normalized) 를 복원할 수 없습니다. "
            "다장 발급분을 정리(회수)한 뒤 다시 시도하십시오."
        )

    op.drop_constraint(
        "ck_event_invitations_seq_range", "event_invitations", type_="check"
    )
    op.drop_constraint(
        "uq_event_invitations_event_phone_seq", "event_invitations", type_="unique"
    )
    op.create_unique_constraint(
        "uq_event_invitations_event_phone",
        "event_invitations",
        ["event_id", "phone_normalized"],
    )
    op.drop_column("event_invitations", "seq")
