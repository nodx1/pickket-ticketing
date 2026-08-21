"""F01 / I2 / I4 — run the real payment-attempt migration on PostgreSQL.

This verifier creates a transaction-local schema, builds the *pre-migration*
``payment_attempts`` shape, imports the repository migration, and executes its
real ``upgrade()`` through Alembic.  The outer transaction is always rolled
back, so neither application rows nor migration metadata are changed.

Credentials are read inside the process from the local ``pickket-v2-db``
container environment.  They are never accepted as command-line arguments and
never printed.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f01_migration_pg.py

The verifier refuses every host/database except
``127.0.0.1:5435/pickket_v2_dev``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import uuid
from pathlib import Path
from types import ModuleType

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from nice_pa_pg_support import DATABASE, HOST, PORT, local_async_url


MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "alembic/versions/payattempt_0801_multi_tid_per_moid.py"
)


def _load_migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("nice_pa_f01_migration", MIGRATION)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import migration: {MIGRATION}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.revision != "payattempt_0801" or module.down_revision != "phoneidx_0731":
        raise AssertionError(
            "F01 migration topology changed: "
            f"revision={module.revision!r} down={module.down_revision!r}"
        )
    return module


async def _expect_unique_violation(connection, statement: str, values: dict) -> str:
    savepoint = await connection.begin_nested()
    try:
        await connection.execute(text(statement), values)
    except IntegrityError as exc:
        await savepoint.rollback()
        cause = getattr(exc, "orig", None)
        driver_cause = getattr(cause, "__cause__", None) or cause
        return str(getattr(driver_cause, "constraint_name", "") or exc)
    else:
        await savepoint.rollback()
        raise AssertionError("expected UNIQUE violation, INSERT succeeded")


async def main() -> int:
    engine = create_async_engine(local_async_url(), pool_size=1, max_overflow=0)
    schema = f"nice_pa_f01_{uuid.uuid4().hex[:12]}"
    migration = _load_migration()

    checks: list[tuple[str, bool, str]] = []
    async with engine.connect() as connection:
        current = await connection.scalar(text("SELECT current_database()"))
        if current != DATABASE:
            raise RuntimeError(f"refusing database {current!r}; expected {DATABASE!r}")
        # The read-only guard query opens SQLAlchemy's implicit transaction.
        # End it before starting the transaction whose rollback is our cleanup.
        await connection.rollback()

        transaction = await connection.begin()
        try:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            await connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
            await connection.execute(
                text(
                    """
                    CREATE TABLE payment_attempts (
                        id uuid PRIMARY KEY,
                        order_id uuid NOT NULL,
                        attempt_no integer NOT NULL,
                        payment_id varchar(120) NOT NULL,
                        pg_transaction_id varchar(200)
                    )
                    """
                )
            )
            await connection.execute(
                text(
                    "CREATE UNIQUE INDEX uq_payment_attempts_payment_id "
                    "ON payment_attempts(payment_id)"
                )
            )

            legacy_id = uuid.uuid4()
            legacy_order = uuid.uuid4()
            await connection.execute(
                text(
                    "INSERT INTO payment_attempts "
                    "(id,order_id,attempt_no,payment_id,pg_transaction_id) "
                    "VALUES (:id,:order_id,1,'legacy-one-click',NULL)"
                ),
                {"id": legacy_id, "order_id": legacy_order},
            )

            def run_upgrade(sync_connection) -> None:
                context = MigrationContext.configure(sync_connection)
                with Operations.context(context):
                    migration.upgrade()

            await connection.run_sync(run_upgrade)

            preserved = await connection.execute(
                text(
                    "SELECT payment_id, pg_transaction_id FROM payment_attempts "
                    "WHERE id=:id"
                ),
                {"id": legacy_id},
            )
            checks.append(
                (
                    "legacy one-click row preserved",
                    preserved.one() == ("legacy-one-click", None),
                    "upgrade must not rewrite/delete existing TID-NULL attempts",
                )
            )

            nice_order = uuid.uuid4()
            insert_sql = """
                INSERT INTO payment_attempts
                    (id,order_id,attempt_no,payment_id,pg_transaction_id)
                VALUES (:id,:order_id,:attempt_no,:payment_id,:tid)
            """
            await connection.execute(
                text(insert_sql),
                {
                    "id": uuid.uuid4(), "order_id": nice_order, "attempt_no": 1,
                    "payment_id": "same-moid", "tid": "F01-TID-A",
                },
            )
            await connection.execute(
                text(insert_sql),
                {
                    "id": uuid.uuid4(), "order_id": nice_order, "attempt_no": 2,
                    "payment_id": "same-moid", "tid": "F01-TID-B",
                },
            )
            count = await connection.scalar(
                text("SELECT count(*) FROM payment_attempts WHERE payment_id='same-moid'")
            )
            checks.append(("same Moid accepts distinct TIDs", count == 2, f"rows={count}"))

            duplicate_pair_constraint = await _expect_unique_violation(
                connection,
                insert_sql,
                {
                    "id": uuid.uuid4(), "order_id": nice_order, "attempt_no": 3,
                    "payment_id": "same-moid", "tid": "F01-TID-A",
                },
            )
            checks.append(
                (
                    "same (Moid,TID) rejected",
                    "uq_payment_attempts_payment_tid" in duplicate_pair_constraint
                    or "uq_payment_attempts_tid_global" in duplicate_pair_constraint,
                    duplicate_pair_constraint,
                )
            )

            duplicate_legacy_constraint = await _expect_unique_violation(
                connection,
                insert_sql,
                {
                    "id": uuid.uuid4(), "order_id": uuid.uuid4(), "attempt_no": 1,
                    "payment_id": "legacy-one-click", "tid": None,
                },
            )
            checks.append(
                (
                    "one-click TID-NULL uniqueness preserved",
                    "uq_payment_attempts_payment_id_no_tid" in duplicate_legacy_constraint,
                    duplicate_legacy_constraint,
                )
            )

            duplicate_tid_constraint = await _expect_unique_violation(
                connection,
                insert_sql,
                {
                    "id": uuid.uuid4(), "order_id": uuid.uuid4(), "attempt_no": 1,
                    "payment_id": "different-moid", "tid": "F01-TID-B",
                },
            )
            checks.append(
                (
                    "TID globally unique across orders/Moids",
                    "uq_payment_attempts_tid_global" in duplicate_tid_constraint,
                    duplicate_tid_constraint,
                )
            )

            indexes = {
                row[0]: row[1]
                for row in (
                    await connection.execute(
                        text(
                            "SELECT indexname,indexdef FROM pg_indexes "
                            "WHERE schemaname=:schema AND tablename='payment_attempts'"
                        ),
                        {"schema": schema},
                    )
                ).all()
            }
            expected = {
                "uq_payment_attempts_payment_id_no_tid",
                "uq_payment_attempts_payment_tid",
                "uq_payment_attempts_tid_global",
            }
            checks.append(
                (
                    "all three post-migration indexes exist",
                    expected.issubset(indexes),
                    f"indexes={sorted(indexes)}",
                )
            )
        finally:
            await transaction.rollback()
    await engine.dispose()

    ok = True
    print(f"F01 target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
    print(f"F01 migration: {migration.revision} <- {migration.down_revision}")
    for name, passed, detail in checks:
        ok &= passed
        print(f"{'PASS' if passed else 'FAIL'}  {name}: {detail}")
    print("cleanup: transaction rolled back; no application rows or schema retained")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
