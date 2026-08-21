"""P3 서비스 모듈 단위 테스트 — import 및 기본 동작 검증."""

import pytest
import uuid
from datetime import datetime, timezone
from decimal import Decimal


# ── P3-5: Scalping detector ──

def test_scalping_detector_import():
    from app.services.scalping_detector import ScalpingScore
    score = ScalpingScore(
        user_id=uuid.uuid4(), total_score=20, velocity_score=5,
        bulk_score=5, resale_score=5, ip_cluster_score=5,
    )
    assert score.flagged is False
    assert score.total_score == 20

    high = ScalpingScore(
        user_id=uuid.uuid4(), total_score=80, velocity_score=30,
        bulk_score=20, resale_score=15, ip_cluster_score=15,
    )
    assert high.flagged is True


# ── P3-6: Fraud detector ──

def test_fraud_detector_import():
    from app.services.fraud_detector import FraudScore
    score = FraudScore(
        order_id=uuid.uuid4(), user_id=uuid.uuid4(),
        total_score=10, card_velocity_score=0, amount_anomaly_score=0,
        geo_velocity_score=0, device_score=0, failure_pattern_score=0,
    )
    assert score.action == "allow"

    blocked = FraudScore(
        order_id=uuid.uuid4(), user_id=uuid.uuid4(),
        total_score=85, card_velocity_score=20, amount_anomaly_score=20,
        geo_velocity_score=15, device_score=15, failure_pattern_score=15,
    )
    assert blocked.action == "block"


# ── P3-7: Price advisor ──

def test_price_advisor_dataclasses():
    from app.services.price_advisor import PriceSuggestion, PriceAdvisorResult
    suggestion = PriceSuggestion(
        tier_name="VIP",
        current_price=Decimal("50000"),
        suggested_min=Decimal("40000"),
        suggested_optimal=Decimal("55000"),
        suggested_max=Decimal("70000"),
        confidence=0.75,
        reasoning=["높은 수요"],
    )
    assert suggestion.tier_name == "VIP"

    result = PriceAdvisorResult(event_id=uuid.uuid4())
    assert result.demand_score == 0.0
    assert result.market_position == "average"


def test_price_advisor_market_position():
    from app.services.price_advisor import _determine_market_position

    class FakeEvent:
        category = "concert"
    assert _determine_market_position(FakeEvent(), {"sell_through": 0.9}) == "luxury"
    assert _determine_market_position(FakeEvent(), {"sell_through": 0.5}) == "premium"

    class E2:
        category = "exhibition"
    assert _determine_market_position(E2(), {"sell_through": 0.5}) == "budget"

    class E3:
        category = "sports"
    assert _determine_market_position(E3(), {"sell_through": 0.5}) == "average"


def test_price_advisor_tier_suggestion():
    from app.services.price_advisor import _generate_tier_suggestion, PriceSuggestion

    class FakeTier:
        name = "일반석"
        base_price = 50000

    historical = {
        "avg_price": Decimal("50000"), "min_price": Decimal("10000"),
        "max_price": Decimal("200000"), "sell_through": 0.6,
    }
    result = _generate_tier_suggestion(FakeTier(), 0.8, historical, "premium")
    assert isinstance(result, PriceSuggestion)
    assert result.confidence > 0
    assert any("높은 수요" in r for r in result.reasoning)

    result_low = _generate_tier_suggestion(FakeTier(), 0.2, historical, "budget")
    assert any("낮은 수요" in r for r in result_low.reasoning)

    class ZeroTier:
        name = "무료"
        base_price = 0
    result_zero = _generate_tier_suggestion(ZeroTier(), 0.5, historical, "average")
    assert result_zero.current_price == Decimal("0")


# ── P3-10: Gamification V2 ──

def test_gamification_v2_import():
    from app.services.gamification_v2 import (
        ChallengeType, StreakInfo, LeaderboardEntry, Challenge,
    )
    streak = StreakInfo(
        user_id=uuid.uuid4(), current_streak=5, longest_streak=10,
        last_activity_date="2026-04-01", next_milestone=7, milestone_reward_ap=100,
    )
    assert streak.current_streak == 5

    entry = LeaderboardEntry(rank=1, user_id="u1", display_name="Test", score=100)
    assert entry.rank == 1

    challenge = Challenge(
        id="c1", type=ChallengeType.ATTEND_EVENTS, title="Test",
        description="Desc", target=10, reward_ap=50,
        reward_badge="badge1", starts_at="2026-04-01", ends_at="2026-04-30",
    )
    assert challenge.target == 10
    assert challenge.progress == 0


# ── P3-11: Social service ──

def test_social_service_import():
    from app.services.social_service import (
        FriendSuggestion, ActivityFeedItem, SocialProof,
    )
    item = ActivityFeedItem(
        id="a1", actor_id="u1", actor_name="Alice", action="purchased",
        target_type="event", target_id="ev1", target_title="Concert",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    assert item.action == "purchased"

    proof = SocialProof(
        event_id="ev1", friends_attending=3, friend_names=["Alice", "Bob"],
        network_interest=15, trending_in_network=True,
    )
    assert proof.friends_attending == 3

    suggestion = FriendSuggestion(
        user_id="u2", display_name="Bob", mutual_count=3, reason="same_events",
    )
    assert suggestion.mutual_count == 3


# ── P3-15: Compliance automation ──

def test_compliance_automation_import():
    from app.services.compliance_automation import (
        ComplianceCheck, ComplianceStatus, ComplianceResult, ComplianceReport,
    )
    result = ComplianceResult(
        check=ComplianceCheck.DATA_RETENTION,
        status=ComplianceStatus.PASS, message="OK",
    )
    assert result.status == ComplianceStatus.PASS

    report = ComplianceReport(
        entity_type="event", entity_id="ev1", results=[result],
    )
    assert report.overall_status == ComplianceStatus.PASS
    assert report.score == 100

    # Test fail propagation
    fail_result = ComplianceResult(
        check=ComplianceCheck.AGE_VERIFICATION,
        status=ComplianceStatus.FAIL, message="미인증",
    )
    fail_report = ComplianceReport(
        entity_type="event", entity_id="ev2", results=[result, fail_result],
    )
    assert fail_report.overall_status == ComplianceStatus.FAIL


# ── P3-16: Programmatic SEO ──

def test_programmatic_seo_import():
    from app.services.programmatic_seo import SEOMeta, SitemapEntry, render_sitemap_xml

    meta = SEOMeta(title="Test Event", description="Desc")
    assert meta.title == "Test Event"
    assert meta.robots == "index, follow"

    entry = SitemapEntry(
        loc="https://example.com/events/1",
        lastmod=datetime.now(timezone.utc).isoformat(),
    )
    assert entry.priority == 0.7

    xml = render_sitemap_xml([entry])
    assert "<urlset" in xml
    assert entry.loc in xml


# ── P3-2: Agent marketplace ──

def test_agent_marketplace_import():
    from app.services.agent_marketplace import (
        AgentStatus, AgentCategory, AgentListing, AgentReview,
    )
    listing = AgentListing(
        id="agent-1", name="Test Agent", description="Desc",
        developer_id="dev1", developer_name="Dev",
        category=AgentCategory.TICKET_BUYER, capabilities=["search"],
    )
    assert listing.status == AgentStatus.PENDING
    assert listing.install_count == 0

    review = AgentReview(
        id="r1", agent_id="agent-1", user_id="u1",
        rating=5, comment="Great",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    assert review.rating == 5


# ── P3-3: Rule engine ──

def test_rule_engine_import():
    from app.services.rule_engine import (
        TriggerType, ConditionOperator, ActionType,
        Condition, Action, Rule, RuleExecutionLog, get_templates,
    )
    cond = Condition(field="sold_count", operator=ConditionOperator.GTE, value=100)
    assert cond.evaluate({"sold_count": 150}) is True
    assert cond.evaluate({"sold_count": 50}) is False

    action = Action(type=ActionType.NOTIFY_ORGANIZER, params={"msg": "Sold out soon!"})
    assert action.to_dict()["type"] == "notify_organizer"

    restored = Action.from_dict(action.to_dict())
    assert restored.type == ActionType.NOTIFY_ORGANIZER

    rule = Rule(
        id="r1", name="Alert", event_id="ev1", organizer_id="org1",
        trigger=TriggerType.CAPACITY_THRESHOLD,
        conditions=[cond], actions=[action],
    )
    assert rule.is_active is True

    templates = get_templates()
    assert isinstance(templates, list)
    assert len(templates) > 0


# ── P3-4: Traffic classifier V2 ──

def test_traffic_classifier_v2_import():
    from app.services.traffic_classifier_v2 import (
        TrafficTier, ClassificationResult,
        extract_user_agent_signals, extract_header_signals,
    )
    result = ClassificationResult(
        session_id="sess-1", tier=TrafficTier.HUMAN, confidence=0.95,
    )
    assert result.action == "allow"

    malicious = ClassificationResult(
        session_id="sess-2", tier=TrafficTier.MALICIOUS, confidence=0.99,
    )
    assert malicious.action == "block"

    signals = extract_user_agent_signals("Mozilla/5.0 Chrome/120")
    assert isinstance(signals, dict)

    header_signals = extract_header_signals({"Accept-Language": "ko-KR"})
    assert isinstance(header_signals, dict)


# ── P3-14: Multi-currency ──

def test_multi_currency_import():
    from app.services.multi_currency import (
        Currency, CurrencyConfig, detect_currency_from_locale,
        get_supported_currencies, get_payment_gateway,
    )
    assert detect_currency_from_locale("ko-KR") == "KRW"
    assert detect_currency_from_locale("en-US") == "USD"
    assert detect_currency_from_locale("ja-JP") == "JPY"

    currencies = get_supported_currencies()
    assert isinstance(currencies, list)
    assert len(currencies) > 0

    gateway = get_payment_gateway("KRW")
    assert isinstance(gateway, str)


# ── P3-1: MCP server ──

def test_mcp_server_import():
    from app.services.mcp_server import (
        MCPScope, MCPToolResult, MCPContext, get_tool_definitions, validate_scope,
    )
    ctx = MCPContext(
        user_id=uuid.uuid4(), agent_name="test-agent",
        scopes=["view", "bid"], token_id=uuid.uuid4(),
    )
    assert ctx.agent_name == "test-agent"

    assert validate_scope(ctx, MCPScope.VIEW) is None
    assert validate_scope(ctx, MCPScope.BID) is None

    denied = validate_scope(ctx, MCPScope.PURCHASE)
    assert denied is not None
    assert denied.success is False

    tools = get_tool_definitions()
    assert isinstance(tools, list)
    assert len(tools) >= 8


# ── P3-12: Sandbox service ──

@pytest.mark.asyncio
async def test_sandbox_service_import():
    from app.services.sandbox_service import is_sandbox_request, mock_payment

    assert await is_sandbox_request("pk_sandbox_abc123") is True
    assert await is_sandbox_request("sk_sandbox_abc123") is True
    assert await is_sandbox_request("pk_live_abc123") is False

    payment = await mock_payment(50000)
    assert payment["success"] is True
    assert "payment_id" in payment

    failed = await mock_payment(50000, should_fail=True)
    assert failed["success"] is False
