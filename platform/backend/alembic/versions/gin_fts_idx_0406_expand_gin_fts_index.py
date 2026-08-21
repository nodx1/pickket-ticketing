"""expand GIN full-text search index to 4 columns

Revision ID: gin_fts_idx_0406
Revises: z7a8b9c0d1e2
Create Date: 2026-04-06
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "gin_fts_idx_0406"
down_revision = "z7a8b9c0d1e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop old GIN index (title + description only)
    op.execute("DROP INDEX IF EXISTS idx_event_fts")

    # Create new GIN index covering all 4 searchable columns
    op.execute("""
        CREATE INDEX idx_event_fts ON events USING gin(
            to_tsvector('simple',
                COALESCE(title, '') || ' ' ||
                COALESCE(description, '') || ' ' ||
                COALESCE(venue, '') || ' ' ||
                COALESCE(artist_name, '')
            )
        )
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_event_fts")

    # Restore original 2-column index
    op.execute("""
        CREATE INDEX idx_event_fts ON events USING gin(
            to_tsvector('simple',
                COALESCE(title, '') || ' ' ||
                COALESCE(description, '')
            )
        )
    """)
