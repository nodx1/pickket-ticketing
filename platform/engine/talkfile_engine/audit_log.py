"""
RISE Audit Log
===============
Immutable audit trail for all ticket transactions.

Regulatory compliance:
  - 암표3법: full transaction history + identity verification status
  - 공연법: compliance reporting
  - 소비자보호법: transparency reports (anonymized)
"""

import hashlib
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from statistics import median


@dataclass
class AuditEntry:
    """Single immutable audit record."""
    audit_id: str
    timestamp: datetime
    event_id: str
    action: str
    user_id: str
    tier_id: str
    sale_mode: str
    details: dict = field(default_factory=dict)
    ip_hash: str = ""
    result: str = ""


class AuditLog:
    """Append-only audit log for all ticket operations."""

    def __init__(self):
        self._entries: list[AuditEntry] = []

    def log(
        self,
        event_id: str,
        action: str,
        user_id: str,
        tier_id: str,
        sale_mode: str,
        details: dict | None = None,
        ip_hash: str = "",
        result: str = "success",
    ) -> str:
        """Add an immutable audit entry. Returns audit_id."""
        audit_id = str(uuid.uuid4())
        entry = AuditEntry(
            audit_id=audit_id,
            timestamp=datetime.now(timezone.utc),
            event_id=event_id,
            action=action,
            user_id=user_id,
            tier_id=tier_id,
            sale_mode=sale_mode,
            details=details or {},
            ip_hash=ip_hash,
            result=result,
        )
        self._entries.append(entry)
        return audit_id

    def query(
        self,
        event_id: str,
        user_id: str | None = None,
        action: str | None = None,
        tier_id: str | None = None,
    ) -> list[AuditEntry]:
        """Query audit entries by filters."""
        results = [e for e in self._entries if e.event_id == event_id]
        if user_id is not None:
            results = [e for e in results if e.user_id == user_id]
        if action is not None:
            results = [e for e in results if e.action == action]
        if tier_id is not None:
            results = [e for e in results if e.tier_id == tier_id]
        return results

    @property
    def entries(self) -> list[AuditEntry]:
        """Read-only access to all entries."""
        return list(self._entries)

    def generate_transparency_report(self, event_id: str, tier_id: str) -> dict:
        """
        Generate public transparency report (anonymized).
        No personal data included.
        """
        entries = self.query(event_id=event_id, tier_id=tier_id)

        purchases = [e for e in entries if e.action in ("purchase", "allocate", "bid_won")]
        prices = [e.details.get("price", 0) for e in purchases if "price" in e.details]
        total_participants = len(set(e.user_id for e in entries if e.action in ("bid", "purchase", "apply")))

        # Participant count band (not exact)
        if total_participants < 100:
            participant_band = "< 100"
        elif total_participants < 500:
            participant_band = "100-500"
        elif total_participants < 1000:
            participant_band = "500-1,000"
        elif total_participants < 5000:
            participant_band = "1,000-5,000"
        else:
            participant_band = "5,000+"

        report = {
            "event_id": event_id,
            "tier_id": tier_id,
            "participant_band": participant_band,
            "total_sold": len(purchases),
            "allocation_method": (
                Counter(e.sale_mode for e in entries).most_common(1)[0][0]
                if entries else "unknown"
            ),
        }

        if prices:
            report["price_min"] = min(prices)
            report["price_max"] = max(prices)
            report["price_median"] = median(prices)

        return report

    def generate_compliance_report(self, event_id: str) -> dict:
        """
        Generate regulatory compliance report (암표3법).
        Full transaction history with verification status.
        """
        entries = self.query(event_id=event_id)

        transactions = []
        for e in entries:
            transactions.append({
                "audit_id": e.audit_id,
                "timestamp": e.timestamp.isoformat(),
                "action": e.action,
                "user_id_hash": hashlib.sha256(e.user_id.encode()).hexdigest()[:12],
                "tier_id": e.tier_id,
                "sale_mode": e.sale_mode,
                "result": e.result,
                "identity_verified": e.details.get("identity_verified", False),
                "price": e.details.get("price"),
            })

        return {
            "event_id": event_id,
            "total_transactions": len(transactions),
            "transactions": transactions,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
