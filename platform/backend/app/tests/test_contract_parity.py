"""Cross-language contract parity: Python enum ↔ generated TS contract.

This test pins the ordering AND values of `backend/app/models/*` enums to
`packages/lib/src/contracts/generated/*.ts`. If Python is changed without
running `scripts/codegen/generate_ts_contracts.py`, this test fails so that
the drift is caught in pytest (in addition to CI `api-schema-drift`).

Parsing is regex-based so we don't need node/ts-node in the Python venv.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.models.event import EventStatus
from app.models.order import OrderStatus

PROJECT_ROOT = Path(__file__).resolve().parents[3]
GENERATED_DIR = PROJECT_ROOT / "packages" / "lib" / "src" / "contracts" / "generated"


def _parse_ts_const_array(path: Path, const_name: str) -> list[str]:
    """Extract string literals from `export const NAME = [ "a", "b", ... ] as const;`."""
    if not path.exists():
        pytest.skip(f"Generated contract not found: {path.relative_to(PROJECT_ROOT)} — run scripts/codegen/generate_ts_contracts.py first")
    source = path.read_text(encoding="utf-8")
    block_match = re.search(
        rf"export const {re.escape(const_name)} = \[(.*?)\] as const;",
        source,
        re.DOTALL,
    )
    if not block_match:
        pytest.fail(f"Could not locate `export const {const_name} = [...] as const;` in {path}")
    body = block_match.group(1)
    return re.findall(r'"([^"]*)"', body)


def test_event_status_parity_python_vs_generated_ts():
    python_values = [e.value for e in EventStatus]
    ts_values = _parse_ts_const_array(
        GENERATED_DIR / "event-status.ts", "V2_EVENT_STATUSES_GENERATED"
    )
    assert python_values == ts_values, (
        f"EventStatus drift detected between Python and generated TS.\n"
        f"  Python : {python_values}\n"
        f"  TS gen : {ts_values}\n"
        f"Run `python scripts/codegen/generate_ts_contracts.py` and commit the result."
    )


def test_order_status_parity_python_vs_generated_ts():
    python_values = [e.value for e in OrderStatus]
    ts_values = _parse_ts_const_array(
        GENERATED_DIR / "order-status.ts", "V2_ORDER_STATUSES_GENERATED"
    )
    assert python_values == ts_values, (
        f"OrderStatus drift detected between Python and generated TS.\n"
        f"  Python : {python_values}\n"
        f"  TS gen : {ts_values}\n"
        f"Run `python scripts/codegen/generate_ts_contracts.py` and commit the result."
    )


def test_generated_barrel_exists():
    """Smoke test: scripts/codegen output must include a barrel re-export."""
    barrel = GENERATED_DIR / "index.ts"
    assert barrel.exists(), "Missing contracts/generated/index.ts barrel — run the codegen script"
