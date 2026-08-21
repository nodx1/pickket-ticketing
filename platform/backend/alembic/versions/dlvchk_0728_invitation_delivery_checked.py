"""invitation_dispatch.delivery_checked_at — 알림톡 전달 상태 대사 흔적

왜 필요한가 (실측 2026-07-28, 실계정 발송):
  버튼 링크가 승인 템플릿과 어긋난 발송이
    requestStatusCode = "A000"  (접수 성공 — 코드가 보던 유일한 값)
    messageStatusCode  = "3027" (전달 실패, "버튼 내용이 템플릿과 불일치")
  로 돌아왔다. 즉 **카톡이 도착하지 않았는데 원장에는 status='sent'** 로 남았다.
  대회 당일이었다면 수백 명이 초대권을 못 받은 채 아무도 몰랐을 상황이다.

`status='sent'` 는 "접수됨"이고 "도달함"이 아니다. 도달은 몇 초 뒤 SENS 조회로만 확인된다.
이 컬럼은 그 대사를 언제 했는지 기록해 **같은 건을 매 tick 다시 조회하지 않게** 한다.
  NULL      = 아직 도달 확인 안 됨(대사 대상)
  값 있음   = 확인 완료(도달했거나, 미도달이라 status='failed' 로 내려갔다)

가산·nullable 이라 기존 행·구버전 코드에 무영향.

Revision ID: dlvchk_0728
Revises: carddisc_0728
"""

from alembic import op
import sqlalchemy as sa

revision = "dlvchk_0728"
down_revision = "carddisc_0728"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "invitation_dispatch",
        sa.Column("delivery_checked_at", sa.DateTime(timezone=True), nullable=True),
    )
    # 대사 대상 조회(status='sent' AND delivery_checked_at IS NULL)용 부분 인덱스.
    # 전체 발송 이력이 쌓여도 미확인 건만 훑는다.
    op.create_index(
        "ix_invitation_dispatch_delivery_pending",
        "invitation_dispatch",
        ["updated_at"],
        unique=False,
        postgresql_where=sa.text("status = 'sent' AND delivery_checked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_invitation_dispatch_delivery_pending", table_name="invitation_dispatch")
    op.drop_column("invitation_dispatch", "delivery_checked_at")
