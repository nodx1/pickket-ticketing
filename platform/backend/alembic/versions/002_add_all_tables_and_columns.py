"""add all tables and columns

Revision ID: 002_full_schema
Revises: a9205990a3f5
Create Date: 2026-02-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '002_full_schema'
down_revision: Union[str, Sequence[str]] = "a9205990a3f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: add all missing tables and columns."""

    # ================================================================
    # 1. ALTER existing tables — add missing columns
    # ================================================================

    # --- users: fix verification_level type (Float -> Integer) and add missing columns ---
    op.alter_column('users', 'verification_level',
                    existing_type=sa.Float(),
                    type_=sa.Integer(),
                    existing_nullable=False,
                    postgresql_using='verification_level::integer')

    op.add_column('users', sa.Column('history_score', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('users', sa.Column('is_fanclub_member', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('users', sa.Column('no_show_rate', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('users', sa.Column('cancel_rate', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('users', sa.Column('dispute_rate', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('users', sa.Column('legacy_loyalty', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('users', sa.Column('ci_hash', sa.String(length=128), nullable=True))
    op.add_column('users', sa.Column('di_hash', sa.String(length=128), nullable=True))
    op.add_column('users', sa.Column('date_of_birth', sa.Date(), nullable=True))
    op.add_column('users', sa.Column('nationality', sa.String(length=2), nullable=True))
    op.add_column('users', sa.Column('is_admin', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('users', sa.Column('abuse_score', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('users', sa.Column('payment_account_id', sa.String(length=100), nullable=True))
    op.create_unique_constraint('uq_users_ci_hash', 'users', ['ci_hash'])

    # --- events: add all extended fields ---
    op.add_column('events', sa.Column('category', sa.String(length=50), nullable=False, server_default='CONCERT'))
    op.add_column('events', sa.Column('sub_category', sa.String(length=50), nullable=True))
    op.add_column('events', sa.Column('image_url', sa.String(length=500), nullable=True))
    op.add_column('events', sa.Column('thumbnail_url', sa.String(length=500), nullable=True))
    op.add_column('events', sa.Column('location_city', sa.String(length=50), nullable=True))
    op.add_column('events', sa.Column('artist_name', sa.String(length=200), nullable=True))
    op.add_column('events', sa.Column('age_restriction', sa.String(length=20), nullable=True))
    op.add_column('events', sa.Column('tags', sa.Text(), nullable=True))
    op.add_column('events', sa.Column('is_featured', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('events', sa.Column('bid_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('events', sa.Column('view_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('events', sa.Column('duration_minutes', sa.Integer(), nullable=True))
    op.add_column('events', sa.Column('current_phase', sa.String(length=50), nullable=False, server_default='setup'))
    op.add_column('events', sa.Column('artist_id', sa.UUID(), nullable=True))
    op.add_column('events', sa.Column('session_number', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('events', sa.Column('tour_id', sa.UUID(), nullable=True))
    op.add_column('events', sa.Column('price_cap_multiplier', sa.Float(), nullable=False, server_default='2.0'))
    op.add_column('events', sa.Column('require_identity_verification', sa.Boolean(), nullable=False, server_default='true'))
    op.add_column('events', sa.Column('remainder_strategy', sa.String(length=50), nullable=False, server_default='dutch_auction'))
    op.add_column('events', sa.Column('remainder_trigger_hours', sa.Integer(), nullable=False, server_default='72'))
    op.add_column('events', sa.Column('remainder_dutch_floor_pct', sa.Float(), nullable=False, server_default='50.0'))
    op.add_column('events', sa.Column('remainder_dutch_step_pct', sa.Float(), nullable=False, server_default='5.0'))
    op.add_column('events', sa.Column('remainder_step_interval_min', sa.Integer(), nullable=False, server_default='60'))
    op.add_column('events', sa.Column('multi_max_wins_per_user', sa.Integer(), nullable=False, server_default='2'))
    op.add_column('events', sa.Column('multi_loser_bonus_weight', sa.Float(), nullable=False, server_default='0.05'))
    op.add_column('events', sa.Column('multi_cross_session_dedup', sa.Boolean(), nullable=False, server_default='true'))
    op.add_column('events', sa.Column('resale_enabled', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('events', sa.Column('resale_max_markup_pct', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('events', sa.Column('resale_royalty_pct', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('events', sa.Column('resale_opens_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('events', sa.Column('resale_closes_at', sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f('ix_events_category'), 'events', ['category'], unique=False)
    op.create_index(op.f('ix_events_location_city'), 'events', ['location_city'], unique=False)

    # --- seat_tiers: add sale mode, pricing, dutch, lottery, group, resale fields ---
    op.add_column('seat_tiers', sa.Column('sale_mode', sa.String(length=50), nullable=False, server_default='fixed_fcfs'))
    op.add_column('seat_tiers', sa.Column('face_price', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('seat_tiers', sa.Column('min_price', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('seat_tiers', sa.Column('max_price_cap', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('seat_tiers', sa.Column('dutch_start_price', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('seat_tiers', sa.Column('dutch_floor_price', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('seat_tiers', sa.Column('dutch_step_amount', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('seat_tiers', sa.Column('dutch_step_interval_min', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('seat_tiers', sa.Column('lottery_application_hours', sa.Integer(), nullable=False, server_default='48'))
    op.add_column('seat_tiers', sa.Column('fanclub_discount_pct', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('seat_tiers', sa.Column('allow_group_tickets', sa.Boolean(), nullable=False, server_default='true'))
    op.add_column('seat_tiers', sa.Column('max_group_size', sa.Integer(), nullable=False, server_default='4'))
    op.add_column('seat_tiers', sa.Column('bidding_opens_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('seat_tiers', sa.Column('bidding_closes_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('seat_tiers', sa.Column('sold_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('seat_tiers', sa.Column('resale_allowed', sa.Boolean(), nullable=False, server_default='true'))
    op.add_column('seat_tiers', sa.Column('resale_max_price', sa.Float(), nullable=False, server_default='0.0'))

    # --- bids: add tier_id, amendment tracking, anomaly detection ---
    op.add_column('bids', sa.Column('tier_id', sa.UUID(), nullable=True))
    op.add_column('bids', sa.Column('amendment_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('bids', sa.Column('last_amended_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('bids', sa.Column('anomaly_score', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('bids', sa.Column('anomaly_reason', sa.String(length=500), nullable=True))
    op.create_foreign_key('fk_bids_tier_id', 'bids', 'seat_tiers', ['tier_id'], ['id'])

    # --- allocations: add tier_id, pool, fairness metrics, behavioral metrics ---
    op.add_column('allocations', sa.Column('tier_id', sa.UUID(), nullable=True))
    op.add_column('allocations', sa.Column('pool', sa.String(length=10), nullable=True))
    op.add_column('allocations', sa.Column('gini_coefficient', sa.Float(), nullable=True))
    op.add_column('allocations', sa.Column('overbidding_indicator', sa.Float(), nullable=True))
    op.add_column('allocations', sa.Column('total_consumer_surplus', sa.Float(), nullable=True))
    op.add_column('allocations', sa.Column('weight_price_correlation', sa.Float(), nullable=True))
    op.add_column('allocations', sa.Column('collusion_signal_score', sa.Float(), nullable=False, server_default='0.0'))
    op.add_column('allocations', sa.Column('lottery_seed', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_allocations_tier_id', 'allocations', 'seat_tiers', ['tier_id'], ['id'])

    # ================================================================
    # 2. CREATE new tables (19 tables)
    # ================================================================

    # --- seats ---
    op.create_table('seats',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('section', sa.String(length=50), nullable=False),
        sa.Column('row_number', sa.Integer(), nullable=False),
        sa.Column('seat_number', sa.Integer(), nullable=False),
        sa.Column('quality_score', sa.Float(), nullable=False, server_default='0.5'),
        sa.Column('status', sa.Enum('available', 'held', 'sold', 'reserved', name='seatstatus'), nullable=False, server_default='available'),
        sa.Column('held_by', sa.UUID(), nullable=True),
        sa.Column('held_until', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['held_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id', 'section', 'row_number', 'seat_number', name='uq_seat_position'),
    )

    # --- orders ---
    op.create_table('orders',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=True),
        sa.Column('order_type', sa.Enum('purchase', 'resale_buy', 'resale_sell', name='ordertype'), nullable=False, server_default='purchase'),
        sa.Column('status', sa.Enum('pending', 'payment_required', 'paid', 'confirmed', 'cancelled', 'expired', 'refunded', name='orderstatus'), nullable=False, server_default='pending'),
        sa.Column('quantity', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('unit_price', sa.Float(), nullable=False),
        sa.Column('total_amount', sa.Float(), nullable=False),
        sa.Column('pg_provider', sa.String(length=50), nullable=True),
        sa.Column('pg_transaction_id', sa.String(length=200), nullable=True),
        sa.Column('pg_approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('payment_deadline', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- tickets (depends on seats, orders) ---
    op.create_table('tickets',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=False),
        sa.Column('seat_id', sa.UUID(), nullable=True),
        sa.Column('original_owner_id', sa.UUID(), nullable=False),
        sa.Column('current_owner_id', sa.UUID(), nullable=False),
        sa.Column('purchase_price', sa.Float(), nullable=False),
        sa.Column('sale_mode', sa.String(length=50), nullable=False),
        sa.Column('purchase_order_id', sa.UUID(), nullable=True),
        sa.Column('status', sa.Enum('active', 'transferred', 'cancelled', 'used', 'expired', name='ticketstatus'), nullable=False, server_default='active'),
        sa.Column('qr_code_hash', sa.String(length=128), nullable=True),
        sa.Column('identity_verified', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('is_resalable', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('resale_max_price', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('transfer_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.ForeignKeyConstraint(['seat_id'], ['seats.id']),
        sa.ForeignKeyConstraint(['original_owner_id'], ['users.id']),
        sa.ForeignKeyConstraint(['current_owner_id'], ['users.id']),
        sa.ForeignKeyConstraint(['purchase_order_id'], ['orders.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- ownership_transfers (depends on tickets) ---
    op.create_table('ownership_transfers',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('ticket_id', sa.UUID(), nullable=False),
        sa.Column('from_user_id', sa.UUID(), nullable=True),
        sa.Column('to_user_id', sa.UUID(), nullable=False),
        sa.Column('transfer_type', sa.Enum('primary_sale', 'resale', 'gift', 'cancellation_refund', name='transfertype'), nullable=False),
        sa.Column('price', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('seller_amount', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('platform_fee', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('artist_royalty', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('transferred_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['ticket_id'], ['tickets.id']),
        sa.ForeignKeyConstraint(['from_user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['to_user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- phase_configs ---
    op.create_table('phase_configs',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('phase', sa.String(length=50), nullable=False),
        sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('ends_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('applicable_tier_ids', sa.String(length=2000), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id', 'phase', name='uq_event_phase'),
    )

    # --- lottery_pools ---
    op.create_table('lottery_pools',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=False),
        sa.Column('total_seats', sa.Integer(), nullable=False),
        sa.Column('use_fan_weight', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('status', sa.Enum('open', 'closed', 'drawn', name='lotterypoolstatus'), nullable=False, server_default='open'),
        sa.Column('seed_used', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- lottery_entries (depends on lottery_pools) ---
    op.create_table('lottery_entries',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('pool_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('group_id', sa.UUID(), nullable=True),
        sa.Column('group_size', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('fan_weight', sa.Float(), nullable=False, server_default='1.0'),
        sa.Column('result', sa.Enum('pending', 'won', 'waitlisted', name='lotteryentryresult'), nullable=False, server_default='pending'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['pool_id'], ['lottery_pools.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('pool_id', 'user_id', name='uq_lottery_pool_user'),
    )

    # --- dutch_auction_states ---
    op.create_table('dutch_auction_states',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=False),
        sa.Column('start_price', sa.Float(), nullable=False),
        sa.Column('floor_price', sa.Float(), nullable=False),
        sa.Column('step_amount', sa.Float(), nullable=False),
        sa.Column('step_interval_minutes', sa.Integer(), nullable=False),
        sa.Column('remaining_seats', sa.Integer(), nullable=False),
        sa.Column('status', sa.Enum('pending', 'active', 'completed', 'cancelled', name='dutchauctionstatus'), nullable=False, server_default='pending'),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id', 'tier_id', name='uq_dutch_event_tier'),
    )

    # --- dutch_purchases (depends on dutch_auction_states) ---
    op.create_table('dutch_purchases',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('dutch_state_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('price', sa.Float(), nullable=False),
        sa.Column('quantity', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('purchased_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['dutch_state_id'], ['dutch_auction_states.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- waitlist_entries ---
    op.create_table('waitlist_entries',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('priority_score', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('group_id', sa.UUID(), nullable=True),
        sa.Column('group_size', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('quantity', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('status', sa.Enum('waiting', 'offered', 'accepted', 'expired', 'removed', name='waitliststatus'), nullable=False, server_default='waiting'),
        sa.Column('entered_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tier_id', 'user_id', name='uq_waitlist_tier_user'),
    )
    op.create_index('ix_waitlist_priority', 'waitlist_entries', ['tier_id', 'priority_score'])

    # --- notifications ---
    op.create_table('notifications',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=True),
        sa.Column('tier_id', sa.UUID(), nullable=True),
        sa.Column('type', sa.String(length=50), nullable=False),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('data', sa.JSON(), nullable=True),
        sa.Column('is_read', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('is_sent', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_notifications_user_id'), 'notifications', ['user_id'], unique=False)

    # --- price_alerts ---
    op.create_table('price_alerts',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=False),
        sa.Column('target_price', sa.Float(), nullable=False),
        sa.Column('triggered', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- audit_entries ---
    op.create_table('audit_entries',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('action', sa.String(length=100), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=True),
        sa.Column('tier_id', sa.UUID(), nullable=True),
        sa.Column('sale_mode', sa.String(length=50), nullable=True),
        sa.Column('details', sa.JSON(), nullable=True),
        sa.Column('ip_hash', sa.String(length=64), nullable=True),
        sa.Column('result', sa.String(length=50), nullable=False, server_default='success'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_audit_entries_action'), 'audit_entries', ['action'], unique=False)

    # --- session_history ---
    op.create_table('session_history',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('artist_id', sa.String(length=100), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('session_number', sa.Integer(), nullable=False),
        sa.Column('participated', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('won', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('tier_id', sa.UUID(), nullable=True),
        sa.Column('price_paid', sa.Float(), nullable=False, server_default='0.0'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'event_id', name='uq_session_user_event'),
    )

    # --- groups ---
    op.create_table('groups',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('group_code', sa.String(length=20), nullable=False),
        sa.Column('leader_user_id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=False),
        sa.Column('require_adjacent', sa.Boolean(), nullable=False, server_default='true'),
        sa.ForeignKeyConstraint(['leader_user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('group_code'),
    )

    # --- group_members (depends on groups) ---
    op.create_table('group_members',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('group_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(['group_id'], ['groups.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('group_id', 'user_id', name='uq_group_member'),
    )

    # --- resale_listings (depends on tickets) ---
    op.create_table('resale_listings',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('ticket_id', sa.UUID(), nullable=False),
        sa.Column('seller_id', sa.UUID(), nullable=False),
        sa.Column('asking_price', sa.Float(), nullable=False),
        sa.Column('status', sa.Enum('active', 'sold', 'cancelled', 'expired', name='resalelistingstatus'), nullable=False, server_default='active'),
        sa.Column('seller_receives', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('platform_fee', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('artist_royalty', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['ticket_id'], ['tickets.id']),
        sa.ForeignKeyConstraint(['seller_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- resale_buy_orders ---
    op.create_table('resale_buy_orders',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('tier_id', sa.UUID(), nullable=False),
        sa.Column('buyer_id', sa.UUID(), nullable=False),
        sa.Column('max_price', sa.Float(), nullable=False),
        sa.Column('status', sa.Enum('active', 'matched', 'cancelled', 'expired', name='resalebuyorderstatus'), nullable=False, server_default='active'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.ForeignKeyConstraint(['tier_id'], ['seat_tiers.id']),
        sa.ForeignKeyConstraint(['buyer_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- user_interactions ---
    # --- venues and venue_sections ---
    op.create_table('venues',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('city', sa.String(length=50), nullable=False),
        sa.Column('address', sa.String(length=300), nullable=False, server_default=''),
        sa.Column('total_capacity', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('map_svg_url', sa.String(length=500), nullable=True),
        sa.Column('map_width', sa.Integer(), nullable=False, server_default='1000'),
        sa.Column('map_height', sa.Integer(), nullable=False, server_default='800'),
        sa.Column('thumbnail_url', sa.String(length=500), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table('venue_sections',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('venue_id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=50), nullable=False),
        sa.Column('label', sa.String(length=20), nullable=False),
        sa.Column('capacity', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('svg_path', sa.Text(), nullable=True),
        sa.Column('center_x', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('center_y', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('floor', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('color', sa.String(length=20), nullable=False, server_default='#1E2A78'),
        sa.ForeignKeyConstraint(['venue_id'], ['venues.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table('user_interactions',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=True),
        sa.Column('interaction_type', sa.String(length=20), nullable=False),
        sa.Column('metadata_json', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['event_id'], ['events.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_user_interactions_user_id'), 'user_interactions', ['user_id'], unique=False)
    op.create_index(op.f('ix_user_interactions_interaction_type'), 'user_interactions', ['interaction_type'], unique=False)


def downgrade() -> None:
    """Downgrade schema: drop new tables and columns in reverse order."""

    # ================================================================
    # 1. DROP new tables (reverse creation order)
    # ================================================================
    op.drop_index(op.f('ix_user_interactions_interaction_type'), table_name='user_interactions')
    op.drop_index(op.f('ix_user_interactions_user_id'), table_name='user_interactions')
    op.drop_table('user_interactions')

    op.drop_table('resale_buy_orders')
    op.drop_table('resale_listings')
    op.drop_table('venue_sections')
    op.drop_table('venues')
    op.drop_table('group_members')
    op.drop_table('groups')
    op.drop_table('session_history')

    op.drop_index(op.f('ix_audit_entries_action'), table_name='audit_entries')
    op.drop_table('audit_entries')

    op.drop_table('price_alerts')

    op.drop_index(op.f('ix_notifications_user_id'), table_name='notifications')
    op.drop_table('notifications')

    op.drop_index('ix_waitlist_priority', table_name='waitlist_entries')
    op.drop_table('waitlist_entries')

    op.drop_table('dutch_purchases')
    op.drop_table('dutch_auction_states')
    op.drop_table('lottery_entries')
    op.drop_table('lottery_pools')
    op.drop_table('phase_configs')
    op.drop_table('ownership_transfers')
    op.drop_table('tickets')
    op.drop_table('orders')
    op.drop_table('seats')

    # ================================================================
    # 2. DROP added columns from existing tables (reverse order)
    # ================================================================

    # --- allocations ---
    op.drop_constraint('fk_allocations_tier_id', 'allocations', type_='foreignkey')
    op.drop_column('allocations', 'lottery_seed')
    op.drop_column('allocations', 'collusion_signal_score')
    op.drop_column('allocations', 'weight_price_correlation')
    op.drop_column('allocations', 'total_consumer_surplus')
    op.drop_column('allocations', 'overbidding_indicator')
    op.drop_column('allocations', 'gini_coefficient')
    op.drop_column('allocations', 'pool')
    op.drop_column('allocations', 'tier_id')

    # --- bids ---
    op.drop_constraint('fk_bids_tier_id', 'bids', type_='foreignkey')
    op.drop_column('bids', 'anomaly_reason')
    op.drop_column('bids', 'anomaly_score')
    op.drop_column('bids', 'last_amended_at')
    op.drop_column('bids', 'amendment_count')
    op.drop_column('bids', 'tier_id')

    # --- seat_tiers ---
    op.drop_column('seat_tiers', 'resale_max_price')
    op.drop_column('seat_tiers', 'resale_allowed')
    op.drop_column('seat_tiers', 'sold_count')
    op.drop_column('seat_tiers', 'bidding_closes_at')
    op.drop_column('seat_tiers', 'bidding_opens_at')
    op.drop_column('seat_tiers', 'max_group_size')
    op.drop_column('seat_tiers', 'allow_group_tickets')
    op.drop_column('seat_tiers', 'fanclub_discount_pct')
    op.drop_column('seat_tiers', 'lottery_application_hours')
    op.drop_column('seat_tiers', 'dutch_step_interval_min')
    op.drop_column('seat_tiers', 'dutch_step_amount')
    op.drop_column('seat_tiers', 'dutch_floor_price')
    op.drop_column('seat_tiers', 'dutch_start_price')
    op.drop_column('seat_tiers', 'max_price_cap')
    op.drop_column('seat_tiers', 'min_price')
    op.drop_column('seat_tiers', 'face_price')
    op.drop_column('seat_tiers', 'sale_mode')

    # --- events ---
    op.drop_index(op.f('ix_events_location_city'), table_name='events')
    op.drop_index(op.f('ix_events_category'), table_name='events')
    op.drop_column('events', 'resale_closes_at')
    op.drop_column('events', 'resale_opens_at')
    op.drop_column('events', 'resale_royalty_pct')
    op.drop_column('events', 'resale_max_markup_pct')
    op.drop_column('events', 'resale_enabled')
    op.drop_column('events', 'multi_cross_session_dedup')
    op.drop_column('events', 'multi_loser_bonus_weight')
    op.drop_column('events', 'multi_max_wins_per_user')
    op.drop_column('events', 'remainder_step_interval_min')
    op.drop_column('events', 'remainder_dutch_step_pct')
    op.drop_column('events', 'remainder_dutch_floor_pct')
    op.drop_column('events', 'remainder_trigger_hours')
    op.drop_column('events', 'remainder_strategy')
    op.drop_column('events', 'require_identity_verification')
    op.drop_column('events', 'price_cap_multiplier')
    op.drop_column('events', 'tour_id')
    op.drop_column('events', 'session_number')
    op.drop_column('events', 'artist_id')
    op.drop_column('events', 'current_phase')
    op.drop_column('events', 'duration_minutes')
    op.drop_column('events', 'view_count')
    op.drop_column('events', 'bid_count')
    op.drop_column('events', 'is_featured')
    op.drop_column('events', 'tags')
    op.drop_column('events', 'age_restriction')
    op.drop_column('events', 'artist_name')
    op.drop_column('events', 'location_city')
    op.drop_column('events', 'thumbnail_url')
    op.drop_column('events', 'image_url')
    op.drop_column('events', 'sub_category')
    op.drop_column('events', 'category')

    # --- users ---
    op.drop_constraint('uq_users_ci_hash', 'users', type_='unique')
    op.drop_column('users', 'payment_account_id')
    op.drop_column('users', 'abuse_score')
    op.drop_column('users', 'is_admin')
    op.drop_column('users', 'nationality')
    op.drop_column('users', 'date_of_birth')
    op.drop_column('users', 'di_hash')
    op.drop_column('users', 'ci_hash')
    op.drop_column('users', 'legacy_loyalty')
    op.drop_column('users', 'dispute_rate')
    op.drop_column('users', 'cancel_rate')
    op.drop_column('users', 'no_show_rate')
    op.drop_column('users', 'is_fanclub_member')
    op.drop_column('users', 'history_score')

    # Revert verification_level type from Integer back to Float
    op.alter_column('users', 'verification_level',
                    existing_type=sa.Integer(),
                    type_=sa.Float(),
                    existing_nullable=False,
                    postgresql_using='verification_level::double precision')

    # Drop enum types created for new tables
    sa.Enum(name='resalebuyorderstatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='resalelistingstatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='waitliststatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='dutchauctionstatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='lotteryentryresult').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='lotterypoolstatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='transfertype').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='ticketstatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='orderstatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='ordertype').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='seatstatus').drop(op.get_bind(), checkfirst=True)
