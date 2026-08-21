"""add v3.0 lottery verification, pity tracker, shop, quests, badges, attendance, genre supporter

Revision ID: m7n8o9p0q1r2
Revises: e30686d1d25b
Create Date: 2026-03-04 23:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'm7n8o9p0q1r2'
down_revision: Union[str, Sequence[str], None] = "e30686d1d25b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """v3.0 차세대 고도화 — 신규 테이블 및 컬럼 추가."""

    # -------------------------------------------------------
    # WP01-02: Lottery verification columns on lottery_pools / lottery_entries
    # -------------------------------------------------------
    op.add_column('lottery_pools', sa.Column(
        'commitment_hash', sa.String(64), nullable=True,
    ))
    op.add_column('lottery_pools', sa.Column(
        'verification_data', postgresql.JSON, nullable=True,
    ))
    op.add_column('lottery_entries', sa.Column(
        'client_seed', sa.String(64), nullable=True,
    ))

    # -------------------------------------------------------
    # WP05: Template change requests
    # -------------------------------------------------------
    op.create_table(
        'template_change_requests',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('fanclub_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('fanclubs.id'), nullable=False, index=True),
        sa.Column('old_template', sa.String(50), nullable=True),
        sa.Column('new_template', sa.String(50), nullable=False),
        sa.Column('reason', sa.Text, nullable=False),
        sa.Column('requested_by', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id'), nullable=False),
        sa.Column('status', sa.String(20), nullable=False, server_default='pending',
                  index=True),
        sa.Column('reviewed_by', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id'), nullable=True),
        sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('rejection_reason', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    # -------------------------------------------------------
    # WP06: Conflict of interest flag on fanclub_memberships
    # -------------------------------------------------------
    op.add_column('fanclub_memberships', sa.Column(
        'is_organizer_affiliated', sa.Boolean, nullable=False, server_default='false',
    ))

    # -------------------------------------------------------
    # WP08: Pity tracker
    # -------------------------------------------------------
    op.create_table(
        'pity_trackers',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('domain', sa.String(50), nullable=False),
        sa.Column('artist_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('consecutive_losses', sa.Integer, nullable=False, server_default='0'),
        sa.Column('guaranteed_ticket', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('guaranteed_expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_loss_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_win_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint('user_id', 'domain', 'artist_id',
                           name='uq_pity_user_domain_artist'),
    )

    # -------------------------------------------------------
    # WP09/WP15: AP Shop
    # -------------------------------------------------------
    op.create_table(
        'shop_items',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('name', sa.String(200), nullable=False),
        sa.Column('description', sa.Text, nullable=True),
        sa.Column('category', sa.String(30), nullable=False),
        sa.Column('ap_price', sa.Integer, nullable=False),
        sa.Column('stock', sa.Integer, nullable=True),
        sa.Column('image_url', sa.String(500), nullable=True),
        sa.Column('organizer_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id'), nullable=True),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        'shop_exchanges',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id'), nullable=False, index=True),
        sa.Column('item_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('shop_items.id'), nullable=False, index=True),
        sa.Column('ap_spent', sa.Integer, nullable=False),
        sa.Column('category', sa.String(30), nullable=False),
        sa.Column('status', sa.String(20), nullable=False, server_default='completed'),
        sa.Column('shipping_address', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    # -------------------------------------------------------
    # WP12-13: POINT_LOTTERY + membership tier
    # -------------------------------------------------------
    op.add_column('lottery_entries', sa.Column(
        'invested_ap', sa.Integer, nullable=False, server_default='0',
    ))
    op.add_column('lottery_entries', sa.Column(
        'tier_multiplier', sa.Float, nullable=False, server_default='1.0',
    ))
    op.add_column('lottery_entries', sa.Column(
        'pity_bonus', sa.Float, nullable=False, server_default='1.0',
    ))

    op.add_column('users', sa.Column(
        'membership_tier', sa.String(20), nullable=False, server_default='rookie',
    ))
    op.add_column('users', sa.Column(
        'tier_score', sa.Float, nullable=False, server_default='0.0',
    ))
    op.add_column('users', sa.Column(
        'tier_updated_at', sa.DateTime(timezone=True), nullable=True,
    ))
    op.add_column('users', sa.Column(
        'tier_downgrade_warned_at', sa.DateTime(timezone=True), nullable=True,
    ))

    # WP16: Newcomer Shield
    op.add_column('users', sa.Column(
        'newcomer_uses_remaining', sa.Integer, nullable=False, server_default='3',
    ))

    # -------------------------------------------------------
    # WP14: Quests + Badges + Attendance
    # -------------------------------------------------------
    op.create_table(
        'quests',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('quest_type', sa.String(20), nullable=False),
        sa.Column('title', sa.String(200), nullable=False),
        sa.Column('description', sa.Text, nullable=True),
        sa.Column('ap_reward', sa.Integer, nullable=False, server_default='10'),
        sa.Column('condition_type', sa.String(50), nullable=False),
        sa.Column('condition_count', sa.Integer, nullable=False, server_default='1'),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        'quest_completions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('quest_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('quests.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('completed_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column('ap_awarded', sa.Integer, nullable=False, server_default='0'),
        sa.Column('period_key', sa.String(20), nullable=False, server_default=''),
        sa.UniqueConstraint('user_id', 'quest_id', 'period_key',
                           name='uq_quest_completion_user_quest_period'),
    )

    op.create_table(
        'badges',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('description', sa.Text, nullable=True),
        sa.Column('icon_url', sa.String(500), nullable=True),
        sa.Column('category', sa.String(50), nullable=False),
        sa.Column('condition_type', sa.String(50), nullable=False),
        sa.Column('condition_value', sa.Integer, nullable=False, server_default='1'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        'user_badges',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('badge_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('badges.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('earned_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint('user_id', 'badge_id', name='uq_user_badge'),
    )

    op.create_table(
        'attendance_records',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('checked_date', sa.Date, nullable=False),
        sa.Column('source', sa.String(20), nullable=False, server_default='manual'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint('user_id', 'checked_date',
                           name='uq_attendance_user_date'),
    )

    op.create_table(
        'attendance_streaks',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'),
                  nullable=False, unique=True),
        sa.Column('current_week_days', sa.Integer, nullable=False, server_default='0'),
        sa.Column('consecutive_weeks', sa.Integer, nullable=False, server_default='0'),
        sa.Column('rescue_remaining', sa.Integer, nullable=False, server_default='3'),
        sa.Column('last_week_qualified', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    # -------------------------------------------------------
    # WP18: Genre supporter
    # -------------------------------------------------------
    op.create_table(
        'genre_supporters',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('domain', sa.String(50), nullable=False),
        sa.Column('attendance_count', sa.Integer, nullable=False, server_default='0'),
        sa.Column('is_qualified', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('qualified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ap_rewarded', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint('user_id', 'domain', name='uq_genre_supporter_user_domain'),
    )

    # -------------------------------------------------------
    # WP19-21: Domain enhancement fields on events
    # -------------------------------------------------------
    op.add_column('events', sa.Column(
        'season_ticket_enabled', sa.Boolean, nullable=False, server_default='false',
    ))
    op.add_column('events', sa.Column(
        'home_away_section', sa.String(20), nullable=True,
    ))
    op.add_column('events', sa.Column(
        'time_slot_enabled', sa.Boolean, nullable=False, server_default='false',
    ))
    op.add_column('events', sa.Column(
        'time_slot_capacity', sa.Integer, nullable=True,
    ))
    op.add_column('events', sa.Column(
        'time_slot_duration_minutes', sa.Integer, nullable=True,
    ))


def downgrade() -> None:
    """Reverse v3.0 changes."""
    # Domain enhancement fields
    op.drop_column('events', 'time_slot_duration_minutes')
    op.drop_column('events', 'time_slot_capacity')
    op.drop_column('events', 'time_slot_enabled')
    op.drop_column('events', 'home_away_section')
    op.drop_column('events', 'season_ticket_enabled')

    # Genre supporter
    op.drop_table('genre_supporters')

    # Attendance
    op.drop_table('attendance_streaks')
    op.drop_table('attendance_records')

    # Badges
    op.drop_table('user_badges')
    op.drop_table('badges')

    # Quests
    op.drop_table('quest_completions')
    op.drop_table('quests')

    # User tier + newcomer fields
    op.drop_column('users', 'newcomer_uses_remaining')
    op.drop_column('users', 'tier_downgrade_warned_at')
    op.drop_column('users', 'tier_updated_at')
    op.drop_column('users', 'tier_score')
    op.drop_column('users', 'membership_tier')

    # Lottery entry AP fields
    op.drop_column('lottery_entries', 'pity_bonus')
    op.drop_column('lottery_entries', 'tier_multiplier')
    op.drop_column('lottery_entries', 'invested_ap')

    # AP Shop
    op.drop_table('shop_exchanges')
    op.drop_table('shop_items')

    # Pity tracker
    op.drop_table('pity_trackers')

    # Conflict of interest
    op.drop_column('fanclub_memberships', 'is_organizer_affiliated')

    # Template change requests
    op.drop_table('template_change_requests')

    # Lottery verification
    op.drop_column('lottery_entries', 'client_seed')
    op.drop_column('lottery_pools', 'verification_data')
    op.drop_column('lottery_pools', 'commitment_hash')
