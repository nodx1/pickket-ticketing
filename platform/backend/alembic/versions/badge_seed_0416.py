"""seed initial badge definitions

Revision ID: badge_seed_0416
Revises: eos_phase_0410
Create Date: 2026-04-16
"""

from __future__ import annotations

import uuid
from alembic import op


# revision identifiers
revision = "badge_seed_0416"
down_revision = "eos_phase_0410"
branch_labels = None
depends_on = None


BADGES = [
    # Milestone
    {
        "name": "첫 응모",
        "description": "첫 이벤트 응모 완료",
        "category": "milestone",
        "condition_type": "bid_count",
        "condition_value": 1,
    },
    {
        "name": "첫 티켓",
        "description": "첫 티켓 예매 완료",
        "category": "milestone",
        "condition_type": "ticket_count",
        "condition_value": 1,
    },
    {
        "name": "관람왕",
        "description": "티켓 10개 예매",
        "category": "milestone",
        "condition_type": "ticket_count",
        "condition_value": 10,
    },
    {
        "name": "진성 팬",
        "description": "같은 아티스트 이벤트 5회 응모",
        "category": "milestone",
        "condition_type": "same_artist_bid_count",
        "condition_value": 5,
    },
    # Tier
    {
        "name": "AP 수집가",
        "description": "100 AP 달성",
        "category": "tier",
        "condition_type": "total_ap",
        "condition_value": 100,
    },
    {
        "name": "AP 마스터",
        "description": "1000 AP 달성",
        "category": "tier",
        "condition_type": "total_ap",
        "condition_value": 1000,
    },
    # Community
    {
        "name": "댓글러",
        "description": "첫 댓글 작성",
        "category": "community",
        "condition_type": "comment_count",
        "condition_value": 1,
    },
    {
        "name": "소통왕",
        "description": "댓글 50개 작성",
        "category": "community",
        "condition_type": "comment_count",
        "condition_value": 50,
    },
    # Attendance
    {
        "name": "개근상",
        "description": "7일 연속 출석",
        "category": "attendance",
        "condition_type": "attendance_streak",
        "condition_value": 7,
    },
    {
        "name": "30일 연속",
        "description": "30일 연속 출석",
        "category": "attendance",
        "condition_type": "attendance_streak",
        "condition_value": 30,
    },
]


def upgrade() -> None:
    for b in BADGES:
        op.execute(
            f"""
            INSERT INTO badges (id, name, description, category, condition_type, condition_value, created_at)
            SELECT '{uuid.uuid4()}'::uuid, $${b['name']}$$, $${b['description']}$$, '{b['category']}', '{b['condition_type']}', {b['condition_value']}, NOW()
            WHERE NOT EXISTS (SELECT 1 FROM badges WHERE name = $${b['name']}$$)
            """
        )


def downgrade() -> None:
    names = [b["name"] for b in BADGES]
    names_sql = ", ".join(f"$${n}$$" for n in names)
    op.execute(f"DELETE FROM badges WHERE name IN ({names_sql})")
