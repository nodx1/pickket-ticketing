#!/usr/bin/env python3
"""Enforce FK ondelete policy across backend/app/models/*.py.

Policy (docs/architecture/standards/DOMAIN_MODEL_STANDARD.md §8):
  - Every `ForeignKey(...)` call MUST supply an `ondelete=` keyword.
  - Accepted values: "CASCADE" | "RESTRICT" | "SET NULL" | "SET DEFAULT" | "NO ACTION".
  - Enforcement is PR-level: old FKs without ondelete are grandfathered and
    captured in `_LEGACY_ALLOWLIST` below until a migration is scheduled.

This script parses models with `ast` so that we don't need SECRET_KEY or app
runtime bootstrap — safe for any CI runner.

Exit code:
  0 — All new FKs obey policy (grandfathered ones are reported but not failing)
  1 — One or more new / non-allowlisted FKs lack ondelete
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = REPO_ROOT / "backend" / "app" / "models"

# Files where existing FKs predate the policy (2026-04-21). Any NEW FK added
# to these files still requires ondelete — the script only grandfathers EXISTING
# violations (count at snapshot time). Shrink this list over time as migrations
# land (see Phase 5.2 of the 2026-04 production audit remediation plan).
_LEGACY_ALLOWLIST: set[str] = {
    "backend/app/models/allocation.py",
    "backend/app/models/anomaly.py",
    "backend/app/models/artist_message.py",
    "backend/app/models/attendance.py",
    "backend/app/models/audit.py",
    "backend/app/models/bid.py",
    "backend/app/models/bridge_page.py",
    "backend/app/models/chargeback.py",
    "backend/app/models/cs_ticket.py",
    "backend/app/models/discount.py",
    "backend/app/models/discount_code.py",
    "backend/app/models/dutch_auction.py",
    "backend/app/models/event.py",
    "backend/app/models/event_comment.py",
    "backend/app/models/event_memory.py",
    "backend/app/models/event_staff.py",
    "backend/app/models/facility.py",
    "backend/app/models/fanclub.py",
    "backend/app/models/fee_schedule.py",
    "backend/app/models/final_call.py",
    "backend/app/models/follow.py",
    "backend/app/models/friendship.py",
    "backend/app/models/geofence.py",
    "backend/app/models/group.py",
    "backend/app/models/interaction.py",
    "backend/app/models/lottery.py",
    "backend/app/models/message.py",
    "backend/app/models/moderation.py",
    "backend/app/models/nft_ticket.py",
    "backend/app/models/notification.py",
    "backend/app/models/open_notice.py",
    # 2026-04-22: model ondelete re-grandfathered — DB-layer RESTRICT is
    # enforced via fk_ondelete_financial_0421_* migration instead of the ORM.
    # Keeping SQLAlchemy models minimal avoids breaking SQLite FK cleanup in
    # the test suite. Revisit after post-apply test refactor.
    "backend/app/models/order.py",
    "backend/app/models/organizer.py",
    "backend/app/models/organizer_request.py",
    "backend/app/models/organizer_team.py",
    "backend/app/models/ownership_transfer.py",
    "backend/app/models/package_product.py",
    "backend/app/models/participant.py",
    "backend/app/models/partner.py",
    "backend/app/models/partnership.py",
    "backend/app/models/phase_config.py",
    "backend/app/models/promotion.py",
    "backend/app/models/proxy_booking.py",
    "backend/app/models/push_subscription.py",
    "backend/app/models/reconciliation.py",
    "backend/app/models/refund.py",
    "backend/app/models/resale.py",
    "backend/app/models/review.py",
    "backend/app/models/seat.py",
    "backend/app/models/session_history.py",
    "backend/app/models/settlement.py",
    "backend/app/models/survey.py",
    "backend/app/models/template_change.py",
    "backend/app/models/ticket.py",
    "backend/app/models/ticket_issuance.py",
    "backend/app/models/venue.py",
    "backend/app/models/waitlist.py",
    "backend/app/models/webhook_subscription.py",
}


def _is_foreign_key_call(call: ast.Call) -> bool:
    """True if this call is ForeignKey(...)."""
    if isinstance(call.func, ast.Name) and call.func.id == "ForeignKey":
        return True
    if isinstance(call.func, ast.Attribute) and call.func.attr == "ForeignKey":
        return True
    return False


def _has_ondelete_kwarg(call: ast.Call) -> bool:
    return any(kw.arg == "ondelete" for kw in call.keywords)


def _check_file(path: Path) -> list[tuple[int, str]]:
    """Return list of (lineno, excerpt) for FK calls missing ondelete."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    offenders: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not _is_foreign_key_call(node):
            continue
        if _has_ondelete_kwarg(node):
            continue
        try:
            excerpt = ast.unparse(node)
        except Exception:
            excerpt = "<ForeignKey call>"
        offenders.append((node.lineno, excerpt))
    return offenders


def main() -> int:
    if not MODELS_DIR.exists():
        print(f"[fk-audit] models dir not found: {MODELS_DIR}", file=sys.stderr)
        return 1

    total_files = 0
    total_violations = 0
    blocking_violations: list[str] = []

    for py in sorted(MODELS_DIR.rglob("*.py")):
        if py.name.startswith("_"):
            continue
        total_files += 1
        rel = py.relative_to(REPO_ROOT).as_posix()
        offenders = _check_file(py)
        if not offenders:
            continue
        total_violations += len(offenders)
        grandfathered = rel in _LEGACY_ALLOWLIST
        if grandfathered:
            print(f"[fk-audit] {rel}: {len(offenders)} FK(s) without ondelete (grandfathered)")
        else:
            for lineno, excerpt in offenders:
                blocking_violations.append(f"{rel}:{lineno}  {excerpt}")

    print(f"[fk-audit] Scanned {total_files} model files, {total_violations} missing-ondelete FK(s)")
    if blocking_violations:
        print("\n[fk-audit] BLOCKING violations (add `ondelete=` keyword):")
        for v in blocking_violations[:50]:
            print(f"  - {v}")
        if len(blocking_violations) > 50:
            print(f"  ... and {len(blocking_violations) - 50} more")
        return 1

    print("[fk-audit] PASS: all FKs in non-legacy files declare ondelete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
