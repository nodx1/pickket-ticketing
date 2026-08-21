"""
Audit Log Tests
================
Tests for RISE immutable audit trail:
  - AuditLog.log() entry creation with UUID
  - AuditLog.query() filtering (event_id, user_id, action, tier_id)
  - Multiple entries and insertion ordering
  - generate_transparency_report() (anonymized, participant bands, price stats)
  - generate_compliance_report() (full transaction history)
  - Empty log edge cases
"""

import uuid

import pytest

from talkfile_engine.audit_log import AuditEntry, AuditLog


# ─── Helpers ───


EVENT = "evt-001"
TIER = "tier-vip"


def _populated_log() -> AuditLog:
    """Create an AuditLog pre-filled with mixed entries for query tests."""
    log = AuditLog()
    log.log(EVENT, "bid", "user-A", TIER, "point_lottery", details={"price": 120_000})
    log.log(EVENT, "bid", "user-B", TIER, "point_lottery", details={"price": 90_000})
    log.log(EVENT, "bid_won", "user-A", TIER, "point_lottery", details={"price": 100_000})
    log.log(EVENT, "purchase", "user-C", "tier-std", "fixed_fcfs", details={"price": 50_000})
    log.log("evt-002", "bid", "user-D", "tier-x", "point_lottery", details={"price": 80_000})
    return log


# ─── AuditLog.log() ───


class TestAuditLogCreation:
    """Verify log() produces valid entries with UUIDs."""

    def test_log_returns_uuid_string(self):
        log = AuditLog()
        audit_id = log.log(EVENT, "bid", "user-1", TIER, "point_lottery")
        # Should parse as a valid UUID-4
        parsed = uuid.UUID(audit_id, version=4)
        assert str(parsed) == audit_id

    def test_log_creates_entry_with_correct_fields(self):
        log = AuditLog()
        details = {"price": 100_000, "identity_verified": True}
        audit_id = log.log(
            EVENT, "purchase", "user-1", TIER, "fixed_fcfs",
            details=details, ip_hash="abc123", result="success",
        )
        entries = log.entries
        assert len(entries) == 1
        entry = entries[0]
        assert entry.audit_id == audit_id
        assert entry.event_id == EVENT
        assert entry.action == "purchase"
        assert entry.user_id == "user-1"
        assert entry.tier_id == TIER
        assert entry.sale_mode == "fixed_fcfs"
        assert entry.details == details
        assert entry.ip_hash == "abc123"
        assert entry.result == "success"

    def test_log_default_result_is_success(self):
        log = AuditLog()
        log.log(EVENT, "bid", "user-1", TIER, "point_lottery")
        assert log.entries[0].result == "success"

    def test_log_timestamp_is_utc(self):
        log = AuditLog()
        log.log(EVENT, "bid", "user-1", TIER, "point_lottery")
        ts = log.entries[0].timestamp
        assert ts.tzinfo is not None
        assert ts.tzname() == "UTC"


# ─── AuditLog.query() ───


class TestAuditLogQuery:
    """Verify query filters: event_id, user_id, action, tier_id."""

    def test_query_by_event_id_only(self):
        log = _populated_log()
        results = log.query(event_id=EVENT)
        assert len(results) == 4
        assert all(e.event_id == EVENT for e in results)

    def test_query_by_user_id(self):
        log = _populated_log()
        results = log.query(event_id=EVENT, user_id="user-A")
        assert len(results) == 2
        assert all(e.user_id == "user-A" for e in results)

    def test_query_by_action(self):
        log = _populated_log()
        results = log.query(event_id=EVENT, action="bid")
        assert len(results) == 2
        assert all(e.action == "bid" for e in results)

    def test_query_by_tier_id(self):
        log = _populated_log()
        results = log.query(event_id=EVENT, tier_id="tier-std")
        assert len(results) == 1
        assert results[0].user_id == "user-C"

    def test_query_combined_filters(self):
        log = _populated_log()
        results = log.query(event_id=EVENT, user_id="user-A", action="bid_won")
        assert len(results) == 1
        assert results[0].details["price"] == 100_000

    def test_query_preserves_insertion_order(self):
        log = _populated_log()
        results = log.query(event_id=EVENT)
        actions = [e.action for e in results]
        assert actions == ["bid", "bid", "bid_won", "purchase"]

    def test_query_empty_log_returns_empty(self):
        log = AuditLog()
        results = log.query(event_id="nonexistent")
        assert results == []


# ─── generate_transparency_report() ───


class TestTransparencyReport:
    """Anonymized public report: participant bands, price statistics."""

    def _build_report_log(self) -> AuditLog:
        """Build a log with bids/applies and purchases for reporting."""
        log = AuditLog()
        # 3 bidders, 2 winners
        for i in range(3):
            log.log(EVENT, "bid", f"user-{i}", TIER, "point_lottery")
        log.log(EVENT, "bid_won", "user-0", TIER, "point_lottery", details={"price": 100_000})
        log.log(EVENT, "bid_won", "user-1", TIER, "point_lottery", details={"price": 120_000})
        return log

    def test_participant_band_under_100(self):
        log = self._build_report_log()
        report = log.generate_transparency_report(EVENT, TIER)
        assert report["participant_band"] == "< 100"

    def test_total_sold_count(self):
        log = self._build_report_log()
        report = log.generate_transparency_report(EVENT, TIER)
        assert report["total_sold"] == 2

    def test_price_statistics(self):
        log = self._build_report_log()
        report = log.generate_transparency_report(EVENT, TIER)
        assert report["price_min"] == 100_000
        assert report["price_max"] == 120_000
        assert report["price_median"] == 110_000.0

    def test_report_excludes_user_ids(self):
        """Transparency reports must not contain personal identifiers."""
        log = self._build_report_log()
        report = log.generate_transparency_report(EVENT, TIER)
        report_str = str(report)
        for i in range(3):
            assert f"user-{i}" not in report_str

    def test_participant_band_500_range(self):
        """150 unique bidders should land in the 100-500 band."""
        log = AuditLog()
        for i in range(150):
            log.log(EVENT, "bid", f"u-{i:04d}", TIER, "point_lottery")
        log.log(EVENT, "bid_won", "u-0000", TIER, "point_lottery", details={"price": 80_000})
        report = log.generate_transparency_report(EVENT, TIER)
        assert report["participant_band"] == "100-500"


# ─── generate_compliance_report() ───


class TestComplianceReport:
    """Full regulatory report with all transactions."""

    def test_compliance_includes_all_transactions(self):
        log = _populated_log()
        report = log.generate_compliance_report(EVENT)
        assert report["total_transactions"] == 4
        assert len(report["transactions"]) == 4

    def test_compliance_transactions_have_required_fields(self):
        log = _populated_log()
        report = log.generate_compliance_report(EVENT)
        tx = report["transactions"][0]
        required_keys = {
            "audit_id", "timestamp", "action", "user_id_hash",
            "tier_id", "sale_mode", "result", "identity_verified", "price",
        }
        assert required_keys.issubset(tx.keys())

    def test_compliance_user_id_is_hashed(self):
        log = AuditLog()
        log.log(EVENT, "bid", "very-long-user-id-12345", TIER, "point_lottery")
        report = log.generate_compliance_report(EVENT)
        uid_hash = report["transactions"][0]["user_id_hash"]
        # SHA-256 hex digest truncated to 12 chars
        assert len(uid_hash) == 12
        assert uid_hash != "very-long-us"  # Not a simple truncation
        # Same user always produces same hash
        log.log(EVENT, "bid", "very-long-user-id-12345", TIER, "point_lottery")
        report2 = log.generate_compliance_report(EVENT)
        assert report2["transactions"][0]["user_id_hash"] == report2["transactions"][1]["user_id_hash"]

    def test_compliance_report_for_empty_event(self):
        log = AuditLog()
        report = log.generate_compliance_report("nonexistent")
        assert report["total_transactions"] == 0
        assert report["transactions"] == []
