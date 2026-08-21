"""[F-1] 추첨 commit-reveal v2 — 사전 시드 커밋 컬럼 추가

기존 체계는 추첨과 같은 호출에서 커밋이 생성되는 사후(post-hoc) 커밋이라
운영자가 원하는 결과가 나올 때까지 재실행해도 탐지 불가했다.

새 체계:
  ① 커밋 단계(추첨 전): server_seed 생성·비공개 저장 +
     seed_commitment = H(domain‖pool_id‖server_seed) 영속화(공개 조회 가능)
     — 풀 생성 시점(응모 시작 전)에 생성, legacy 풀은 응모 마감 훅에서 백필
  ② 공개/검증 단계(추첨 후): server_seed reveal + 엔트리 스냅샷 digest +
     당첨자 목록을 result_hash 로 바인딩, verify 가 커밋 일치 + 추첨 재계산
     일치를 모두 확인

lottery_pools 추가 컬럼:
  - server_seed BIGINT      : 비공개 시드 (DRAWN 전 API 노출 금지)
  - seed_commitment VARCHAR(64): 사전 커밋 해시 (공개)
  - committed_at TIMESTAMPTZ: 커밋 영속화 시각
  - drawn_at TIMESTAMPTZ    : 추첨 실행 시각 (committed_at < drawn_at 증명용)

기존 행은 모두 NULL → verify 가 legacy_post_hoc_commit 으로 구분 응답.

Revision ID: cmrv_0611
Revises: pay_attempt_0611
Create Date: 2026-06-11

NOTE: pay_attempt_0611(결제팀 동시 작업) 뒤에 체이닝 — 오케스트레이터가
재체이닝할 수 있음.
"""
from alembic import op
import sqlalchemy as sa


revision = "cmrv_0611"
down_revision = "alloc_uniq_0611"
branch_labels = None
depends_on = None

_TABLE = "lottery_pools"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column("server_seed", sa.BigInteger(), nullable=True))
    op.add_column(
        _TABLE, sa.Column("seed_commitment", sa.String(length=64), nullable=True)
    )
    op.add_column(
        _TABLE, sa.Column("committed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        _TABLE, sa.Column("drawn_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column(_TABLE, "drawn_at")
    op.drop_column(_TABLE, "committed_at")
    op.drop_column(_TABLE, "seed_commitment")
    op.drop_column(_TABLE, "server_seed")
