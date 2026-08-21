"""A/B test service — deterministic variant assignment, event tracking, result calculation."""

import hashlib
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ab_test import ABTest, ABTestAssignment, ABTestEvent, ABTestStatus

logger = logging.getLogger(__name__)


class ABTestService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ──── Variant assignment (deterministic, hash-based) ────

    @staticmethod
    def _pick_variant(test_name: str, user_id: uuid.UUID, variants: list[dict]) -> str:
        """Deterministic variant selection using consistent hashing.

        Hash(test_name + user_id) → bucket into weighted variants.
        Same user always gets the same variant for a given test.
        """
        if not variants:
            raise ValueError("Test has no variants")

        hash_input = f"{test_name}:{user_id}".encode()
        hash_val = int(hashlib.sha256(hash_input).hexdigest(), 16)

        total_weight = sum(v.get("weight", 1) for v in variants)
        bucket = hash_val % total_weight

        cumulative = 0
        for v in variants:
            cumulative += v.get("weight", 1)
            if bucket < cumulative:
                return v["name"]

        # Fallback (should never reach here)
        return variants[-1]["name"]

    async def get_variant(self, test_name: str, user_id: uuid.UUID) -> dict | None:
        """Get the variant for a user in a given test.

        Returns {test_name, variant_name, test_id} or None if test not found/inactive.
        Persists the assignment on first call.
        """
        # Find active test
        result = await self.session.execute(
            select(ABTest).where(
                ABTest.name == test_name,
                ABTest.status == ABTestStatus.RUNNING,
            )
        )
        test = result.scalar_one_or_none()
        if not test:
            return None

        # Check for existing assignment
        result = await self.session.execute(
            select(ABTestAssignment).where(
                ABTestAssignment.test_id == test.id,
                ABTestAssignment.user_id == user_id,
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            return {
                "test_name": test_name,
                "test_id": str(test.id),
                "variant_name": existing.variant_name,
            }

        # Check target audience percentage
        target = test.target_audience or {}
        pct = target.get("percentage", 100)
        if pct < 100:
            # Use hash to deterministically decide inclusion
            inclusion_hash = int(
                hashlib.sha256(f"include:{test_name}:{user_id}".encode()).hexdigest(),
                16,
            )
            if (inclusion_hash % 100) >= pct:
                return None  # User not in target audience

        # Assign variant
        variant_name = self._pick_variant(test_name, user_id, test.variants or [])

        # Upsert assignment (handle race condition)
        stmt = pg_insert(ABTestAssignment).values(
            test_id=test.id,
            user_id=user_id,
            variant_name=variant_name,
        )
        stmt = stmt.on_conflict_do_nothing(
            constraint="uq_ab_assignment_test_user"
        )
        await self.session.execute(stmt)
        await self.session.commit()

        return {
            "test_name": test_name,
            "test_id": str(test.id),
            "variant_name": variant_name,
        }

    # ──── Event tracking ────

    async def track_event(
        self,
        test_name: str,
        user_id: uuid.UUID,
        event_type: str,
        value: float | None = None,
    ) -> bool:
        """Record a metric event (impression, conversion, custom).

        Returns True if recorded, False if test not found.
        """
        # Find the test
        result = await self.session.execute(
            select(ABTest).where(ABTest.name == test_name)
        )
        test = result.scalar_one_or_none()
        if not test:
            return False

        # Get the user's variant assignment
        result = await self.session.execute(
            select(ABTestAssignment.variant_name).where(
                ABTestAssignment.test_id == test.id,
                ABTestAssignment.user_id == user_id,
            )
        )
        variant_name = result.scalar_one_or_none()
        if not variant_name:
            # User not assigned — try to auto-assign
            assignment = await self.get_variant(test_name, user_id)
            if not assignment:
                return False
            variant_name = assignment["variant_name"]

        event = ABTestEvent(
            test_id=test.id,
            user_id=user_id,
            variant_name=variant_name,
            event_type=event_type,
            value=value,
        )
        self.session.add(event)
        await self.session.commit()
        return True

    # ──── Results calculation ────

    async def get_results(self, test_id: uuid.UUID) -> dict:
        """Calculate conversion rates and stats per variant.

        Returns {variants: [{name, assignments, impressions, conversions, conversion_rate, avg_value}]}
        """
        # Get test
        result = await self.session.execute(
            select(ABTest).where(ABTest.id == test_id)
        )
        test = result.scalar_one_or_none()
        if not test:
            return {"variants": [], "total_assignments": 0}

        variant_names = [v["name"] for v in (test.variants or [])]

        # Assignments per variant
        assignment_counts = {}
        result = await self.session.execute(
            select(
                ABTestAssignment.variant_name,
                func.count(ABTestAssignment.id),
            )
            .where(ABTestAssignment.test_id == test_id)
            .group_by(ABTestAssignment.variant_name)
        )
        for row in result.all():
            assignment_counts[row[0]] = row[1]

        # Events per variant grouped by event_type
        event_counts: dict[str, dict[str, int]] = {}
        avg_values: dict[str, dict[str, float | None]] = {}

        result = await self.session.execute(
            select(
                ABTestEvent.variant_name,
                ABTestEvent.event_type,
                func.count(ABTestEvent.id),
                func.avg(ABTestEvent.value),
            )
            .where(ABTestEvent.test_id == test_id)
            .group_by(ABTestEvent.variant_name, ABTestEvent.event_type)
        )
        for row in result.all():
            vname, etype, cnt, avg_val = row
            if vname not in event_counts:
                event_counts[vname] = {}
                avg_values[vname] = {}
            event_counts[vname][etype] = cnt
            avg_values[vname][etype] = float(avg_val) if avg_val is not None else None

        total_assignments = sum(assignment_counts.values())

        variants_result = []
        for vname in variant_names:
            assignments = assignment_counts.get(vname, 0)
            impressions = event_counts.get(vname, {}).get("impression", 0)
            conversions = event_counts.get(vname, {}).get("conversion", 0)
            conversion_rate = (
                round(conversions / impressions * 100, 2)
                if impressions > 0
                else 0.0
            )
            avg_conversion_value = avg_values.get(vname, {}).get("conversion")

            variants_result.append({
                "name": vname,
                "assignments": assignments,
                "impressions": impressions,
                "conversions": conversions,
                "conversion_rate": conversion_rate,
                "avg_value": round(avg_conversion_value, 4) if avg_conversion_value else None,
            })

        return {
            "variants": variants_result,
            "total_assignments": total_assignments,
        }
