"""초대권 1인 상한 5 → 50 (CHECK 제약 확대)

🔴 왜 (발주처 요청, 2026-08-09 · 대표 확정)
   "현재 5매 → 최대 50매로 확대 (특히 이 부분은 조속히)"

상한은 **앱과 DB 두 곳**에 있다. 상수만 바꾸면 6장째부터 DB CHECK 가 거부한다 —
앱 검증만 보면 통과하므로 **마이그레이션이 안 걸린 것을 모른다**. 그래서 검증은
앱을 우회한 직접 INSERT 로 한다(`scripts/verify/invitation_cap_pg.py`).

⚠️ 숫자를 여기 적지 않고 `INVITATION_MAX_PER_PHONE` 을 **import 해서** 쓴다.
   두 벌로 적으면 다음에 한쪽만 바뀐다.

✅ 넓히는 방향이라 기존 행은 전부 통과한다 — upgrade 는 안전하다.

🔴 **되돌릴 수 없다.** downgrade 는 §5 참조 — 6장 이상인 번호가 하나라도 생기면
   실패한다. 실패를 숨기지 않고 명시적으로 중단한다(invseq_0730 의 패턴).

Revision ID: inv50_0809
Revises: gatea_0801
Create Date: 2026-08-09
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.models.go_attendee_ledger import INVITATION_MAX_PER_PHONE

revision = "inv50_0809"
down_revision = "gatea_0801"
branch_labels = None
depends_on = None

_CONSTRAINT = "ck_event_invitations_seq_range"
_TABLE = "event_invitations"
# 🔴 이전 상한. downgrade 사전 점검에만 쓴다 — upgrade 는 이 값을 보지 않는다.
_PREVIOUS_MAX = 5


def upgrade() -> None:
    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        _TABLE,
        f"seq >= 1 AND seq <= {INVITATION_MAX_PER_PHONE}",
    )


def downgrade() -> None:
    # 🔴 사전 점검 — 옛 상한을 넘는 행이 하나라도 있으면 좁은 CHECK 를 복원할 수 없다.
    #    조용히 실패하면 "downgrade 됐다" 고 믿은 채 제약이 사라진 상태가 된다
    #    (invseq_0730 의 downgrade 가 같은 패턴이다).
    conn = op.get_bind()
    over = conn.execute(
        sa.text(f"SELECT count(*) FROM {_TABLE} WHERE seq > :cap"),
        {"cap": _PREVIOUS_MAX},
    ).scalar()
    if over:
        raise RuntimeError(
            f"downgrade 중단: seq > {_PREVIOUS_MAX} 인 초대권이 {over}건 있습니다. "
            f"상한을 {_PREVIOUS_MAX} 로 되돌리면 CHECK 위반으로 실패합니다. "
            "해당 초대권을 회수·삭제한 뒤 다시 시도하십시오. "
            "🔴 이미 발송된 알림톡은 회수할 수 없습니다 — 되돌리기 전에 운영 판단이 필요합니다."
        )

    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        _TABLE,
        f"seq >= 1 AND seq <= {_PREVIOUS_MAX}",
    )
