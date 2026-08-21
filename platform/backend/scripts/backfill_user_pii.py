"""
Backfill legacy plaintext user PII into encrypted-at-rest form.

Run:
  cd backend && .venv/bin/python scripts/backfill_user_pii.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid

from sqlalchemy import text

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.config import settings
from app.core.database import async_session
from app.core.pii import reset_pii_fernet_cache
from app.models.user import User

_PII_PREFIX = "enc::"
BATCH_SIZE = 500


def _is_encrypted(value: object) -> bool:
    return isinstance(value, str) and value.startswith(_PII_PREFIX)


async def backfill() -> None:
    if not settings.PII_ENCRYPTION_KEY:
        raise RuntimeError("PII_ENCRYPTION_KEY must be configured before running backfill")

    reset_pii_fernet_cache()

    async with async_session() as session:
        result = await session.execute(
            text(
                """
                SELECT id, phone, date_of_birth
                FROM users
                WHERE phone IS NOT NULL OR date_of_birth IS NOT NULL
                """
            )
        )
        rows = result.mappings().all()

        target_ids = [
            row["id"]
            for row in rows
            if not _is_encrypted(row["phone"]) or not _is_encrypted(row["date_of_birth"])
        ]

        total = len(target_ids)
        print(f"Users requiring PII backfill: {total}")
        if total == 0:
            print("Nothing to do.")
            return

        processed = 0
        for offset in range(0, total, BATCH_SIZE):
            batch_ids = [uuid.UUID(str(value)) for value in target_ids[offset : offset + BATCH_SIZE]]
            users = []
            for user_id in batch_ids:
                user = await session.get(User, user_id)
                if user is not None:
                    users.append(user)

            for user in users:
                # Re-assign through ORM so TypeDecorator rewrites encrypted values.
                user.phone = user.phone
                user.date_of_birth = user.date_of_birth

            await session.commit()
            processed += len(users)
            print(f"  Backfilled {processed}/{total} users")

    print("Done.")


if __name__ == "__main__":
    asyncio.run(backfill())
