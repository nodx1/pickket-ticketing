"""add missing indexes and bid unique constraint for security/performance

Revision ID: sec_idx_0406a
Revises: a1b2c3d4e5f6
Create Date: 2026-04-06
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "sec_idx_0406a"
down_revision = "gin_fts_idx_0406"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── CRITICAL: 사용자 본인인증 조회 ──
    op.execute("CREATE INDEX IF NOT EXISTS idx_user_ci_hash ON users(ci_hash)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_user_di_hash ON users(di_hash)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_oauth ON users(oauth_provider, oauth_id)"
    )

    # ── HIGH: 장소 도시 검색 ──
    op.execute("CREATE INDEX IF NOT EXISTS idx_venue_city ON venues(city)")

    # ── HIGH: 댓글 목록 페이지네이션 ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_event_comment_event_created "
        "ON event_comments(event_id, created_at)"
    )

    # ── HIGH: 추첨 엔트리 조회 ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_lottery_entry_pool_user "
        "ON lottery_entries(pool_id, user_id)"
    )

    # ── HIGH: 결제 만료 조회 최적화 ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_order_status_deadline "
        "ON orders(status, payment_deadline)"
    )

    # ── MEDIUM: 동정심 시스템 ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pity_tracker_user_domain "
        "ON pity_trackers(user_id, domain)"
    )

    # ── MEDIUM: 장르 서포터 ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_genre_supporter_user_domain "
        "ON genre_supporters(user_id, domain)"
    )

    # ── MEDIUM: 활성 퀘스트 필터 ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_quest_is_active ON quests(is_active)"
    )

    # ── MEDIUM: 출석 기록 ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_attendance_record_user_date "
        "ON attendance_records(user_id, checked_date)"
    )

    # ── MEDIUM: 행동 분석 (테이블 존재 시에만) ──
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_behaviors') THEN
                CREATE INDEX IF NOT EXISTS idx_user_behavior_user ON user_behaviors(user_id);
            END IF;
        END $$;
    """)

    # NOTE: bids 유니크 인덱스는 별도 마이그레이션에서 DB enum 확인 후 추가 예정
    # 모델에 idx_bid_user_event 복합 인덱스가 이미 존재함


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_user_behavior_user")
    op.execute("DROP INDEX IF EXISTS idx_attendance_record_user_date")
    op.execute("DROP INDEX IF EXISTS idx_quest_is_active")
    op.execute("DROP INDEX IF EXISTS idx_genre_supporter_user_domain")
    op.execute("DROP INDEX IF EXISTS idx_pity_tracker_user_domain")
    op.execute("DROP INDEX IF EXISTS idx_order_status_deadline")
    op.execute("DROP INDEX IF EXISTS idx_lottery_entry_pool_user")
    op.execute("DROP INDEX IF EXISTS idx_event_comment_event_created")
    op.execute("DROP INDEX IF EXISTS idx_venue_city")
    op.execute("DROP INDEX IF EXISTS idx_user_oauth")
    op.execute("DROP INDEX IF EXISTS idx_user_di_hash")
    op.execute("DROP INDEX IF EXISTS idx_user_ci_hash")
