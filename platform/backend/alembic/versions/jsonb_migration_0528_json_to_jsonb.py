"""Convert selected JSON columns to JSONB.

Revision ID: jsonb_migration_0528
Revises: db_integrity_0528
Create Date: 2026-05-28 00:00:00.000000
"""

from alembic import context, op


revision = "jsonb_migration_0528"
down_revision = "db_integrity_0528"
branch_labels = None
depends_on = None


JSON_COLUMNS = [
    ("lottery_pools", "verification_data"),
    ("reconciliation_mismatches", "details"),
    ("chargebacks", "evidence"),
    ("artist_messages", "reactions"),
    ("orders", "payment_metadata"),
    ("notifications", "data"),
    ("anomaly_logs", "reasons"),
    ("survey_responses", "answers"),
    ("survey_responses", "metadata_info"),
    ("allocations", "engine_params"),
    ("ab_tests", "variants"),
    ("ab_tests", "target_audience"),
    ("audit_logs", "old_value"),
    ("audit_logs", "new_value"),
    ("public_facilities", "amenities"),
    ("public_facilities", "accessibility"),
    ("public_facilities", "operating_hours"),
    ("public_facilities", "photos"),
    ("events", "discount_policies"),
    ("events", "cancellation_fee_tiers"),
    ("nft_tickets", "attributes"),
    ("refunds", "pg_response"),
    ("user_behaviors", "metadata_json"),
    ("users", "notification_preferences"),
]

TEXT_JSON_COLUMNS = [
    ("audit_entries", "details"),
]


def _is_postgresql() -> bool:
    if context.is_offline_mode():
        return True
    return op.get_bind().dialect.name == "postgresql"


def _alter_json_columns(target_type: str, cast_type: str) -> None:
    for table, column in JSON_COLUMNS:
        op.execute(
            f"ALTER TABLE {table} "
            f"ALTER COLUMN {column} TYPE {target_type} "
            f"USING {column}::{cast_type}"
        )


def upgrade() -> None:
    if not _is_postgresql():
        return

    _alter_json_columns("JSONB", "jsonb")
    for table, column in TEXT_JSON_COLUMNS:
        op.execute(
            f"ALTER TABLE {table} "
            f"ALTER COLUMN {column} TYPE JSONB "
            f"USING CASE WHEN {column} IS NULL THEN NULL ELSE {column}::jsonb END"
        )


def downgrade() -> None:
    if not _is_postgresql():
        return

    for table, column in TEXT_JSON_COLUMNS:
        op.execute(
            f"ALTER TABLE {table} "
            f"ALTER COLUMN {column} TYPE TEXT "
            f"USING CASE WHEN {column} IS NULL THEN NULL ELSE {column}::text END"
        )
    _alter_json_columns("JSON", "json")
