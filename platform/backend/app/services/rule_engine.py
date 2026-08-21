"""P3-3: Automatic rule engine.

Event-driven automation system that allows organizers to define
trigger→condition→action rules:

Examples:
- "When tickets sold > 80%, enable waitlist"
- "When event is 24h away and tickets > 50% unsold, apply 15% discount"
- "When new bid exceeds tier price * 2, flag for review"
- "When refund rate > 10%, notify organizer"

Rules are stored as JSON in Redis, evaluated on event triggers.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from typing import Any
import json
import operator

from app.core.redis import get_redis


RULE_CACHE_TTL = 7 * 86400
FLAGGED_TTL = 86400


class TriggerType(str, Enum):
    TICKET_SOLD = "ticket_sold"
    TIME_BEFORE_EVENT = "time_before_event"
    BID_PLACED = "bid_placed"
    REFUND_REQUESTED = "refund_requested"
    CAPACITY_THRESHOLD = "capacity_threshold"
    REVENUE_THRESHOLD = "revenue_threshold"
    CHECKIN_COUNT = "checkin_count"
    SCHEDULE = "schedule"  # cron-like


class ConditionOperator(str, Enum):
    GT = "gt"
    GTE = "gte"
    LT = "lt"
    LTE = "lte"
    EQ = "eq"
    NEQ = "neq"
    BETWEEN = "between"


class ActionType(str, Enum):
    ENABLE_WAITLIST = "enable_waitlist"
    DISABLE_WAITLIST = "disable_waitlist"
    APPLY_DISCOUNT = "apply_discount"
    REMOVE_DISCOUNT = "remove_discount"
    NOTIFY_ORGANIZER = "notify_organizer"
    NOTIFY_ADMIN = "notify_admin"
    FLAG_FOR_REVIEW = "flag_for_review"
    PAUSE_SALES = "pause_sales"
    RESUME_SALES = "resume_sales"
    SEND_PUSH = "send_push"
    LOG_EVENT = "log_event"


@dataclass
class Condition:
    field: str
    operator: ConditionOperator
    value: Any
    value2: Any = None  # For BETWEEN

    def evaluate(self, context: dict) -> bool:
        actual = context.get(self.field)
        if actual is None:
            return False

        ops = {
            ConditionOperator.GT: operator.gt,
            ConditionOperator.GTE: operator.ge,
            ConditionOperator.LT: operator.lt,
            ConditionOperator.LTE: operator.le,
            ConditionOperator.EQ: operator.eq,
            ConditionOperator.NEQ: operator.ne,
        }

        if self.operator == ConditionOperator.BETWEEN:
            return self.value <= actual <= (self.value2 or self.value)

        op_func = ops.get(self.operator)
        if op_func:
            try:
                return op_func(float(actual), float(self.value))
            except (ValueError, TypeError):
                return op_func(actual, self.value)
        return False

    def to_dict(self) -> dict:
        d = {"field": self.field, "operator": self.operator.value, "value": self.value}
        if self.value2 is not None:
            d["value2"] = self.value2
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Condition":
        return cls(
            field=d["field"],
            operator=ConditionOperator(d["operator"]),
            value=d["value"],
            value2=d.get("value2"),
        )


@dataclass
class Action:
    type: ActionType
    params: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"type": self.type.value, "params": self.params}

    @classmethod
    def from_dict(cls, d: dict) -> "Action":
        return cls(type=ActionType(d["type"]), params=d.get("params", {}))


@dataclass
class Rule:
    id: str
    name: str
    event_id: str
    organizer_id: str
    trigger: TriggerType
    conditions: list[Condition]
    actions: list[Action]
    is_active: bool = True
    cooldown_minutes: int = 30
    last_fired_at: str | None = None
    created_at: str = ""
    match_all: bool = True  # True = AND, False = OR

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "event_id": self.event_id,
            "organizer_id": self.organizer_id,
            "trigger": self.trigger.value,
            "conditions": [c.to_dict() for c in self.conditions],
            "actions": [a.to_dict() for a in self.actions],
            "is_active": self.is_active,
            "cooldown_minutes": self.cooldown_minutes,
            "last_fired_at": self.last_fired_at,
            "created_at": self.created_at,
            "match_all": self.match_all,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Rule":
        return cls(
            id=d["id"],
            name=d["name"],
            event_id=d["event_id"],
            organizer_id=d["organizer_id"],
            trigger=TriggerType(d["trigger"]),
            conditions=[Condition.from_dict(c) for c in d.get("conditions", [])],
            actions=[Action.from_dict(a) for a in d.get("actions", [])],
            is_active=d.get("is_active", True),
            cooldown_minutes=d.get("cooldown_minutes", 30),
            last_fired_at=d.get("last_fired_at"),
            created_at=d.get("created_at", ""),
            match_all=d.get("match_all", True),
        )


@dataclass
class RuleExecutionLog:
    rule_id: str
    rule_name: str
    event_id: str
    trigger: str
    conditions_met: bool
    actions_executed: list[str]
    context_snapshot: dict
    executed_at: str


# ── Rule Storage (Redis) ──────────────────────────────────────────────────────

async def _sadd_with_ttl(redis: Any, key: str, *values: str, ttl: int) -> None:
    await redis.sadd(key, *values)  # expire below
    await redis.expire(key, ttl)


async def create_rule(rule: Rule) -> bool:
    """Store a new rule."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        if not rule.id:
            rule.id = str(uuid.uuid4())[:12]
        if not rule.created_at:
            rule.created_at = datetime.now(timezone.utc).isoformat()

        key = f"v2:rules:event:{rule.event_id}:{rule.id}"
        await redis.set(key, json.dumps(rule.to_dict()), ex=RULE_CACHE_TTL)

        # Index by event
        index_key = f"v2:rules:idx:event:{rule.event_id}"
        await _sadd_with_ttl(redis, index_key, rule.id, ttl=RULE_CACHE_TTL)

        # Index by trigger type
        trigger_key = f"v2:rules:idx:trigger:{rule.trigger.value}"
        await _sadd_with_ttl(
            redis,
            trigger_key,
            f"{rule.event_id}:{rule.id}",
            ttl=RULE_CACHE_TTL,
        )

        return True
    except Exception:
        return False


async def get_rules_for_event(event_id: str) -> list[Rule]:
    """Get all rules for an event."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        index_key = f"v2:rules:idx:event:{event_id}"
        rule_ids = await redis.smembers(index_key)

        rules = []
        for rid_bytes in rule_ids:
            rid = rid_bytes.decode() if isinstance(rid_bytes, bytes) else rid_bytes
            key = f"v2:rules:event:{event_id}:{rid}"
            data = await redis.get(key)
            if data:
                raw = data.decode() if isinstance(data, bytes) else data
                rules.append(Rule.from_dict(json.loads(raw)))

        return rules
    except Exception:
        return []


async def delete_rule(event_id: str, rule_id: str) -> bool:
    """Delete a rule."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        key = f"v2:rules:event:{event_id}:{rule_id}"
        data = await redis.get(key)
        if data:
            raw = data.decode() if isinstance(data, bytes) else data
            rule = Rule.from_dict(json.loads(raw))
            trigger_key = f"v2:rules:idx:trigger:{rule.trigger.value}"
            await redis.srem(trigger_key, f"{event_id}:{rule_id}")

        await redis.delete(key)
        index_key = f"v2:rules:idx:event:{event_id}"
        await redis.srem(index_key, rule_id)
        return True
    except Exception:
        return False


async def update_rule(rule: Rule) -> bool:
    """Update an existing rule."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        key = f"v2:rules:event:{rule.event_id}:{rule.id}"
        await redis.set(key, json.dumps(rule.to_dict()), ex=RULE_CACHE_TTL)
        return True
    except Exception:
        return False


# ── Rule Evaluation ───────────────────────────────────────────────────────────

async def evaluate_trigger(
    trigger_type: TriggerType,
    event_id: str,
    context: dict,
) -> list[RuleExecutionLog]:
    """Evaluate all rules matching a trigger type for an event."""
    redis = get_redis()
    if redis is None:
        return []

    logs = []

    try:
        # Get all rules for this event
        rules = await get_rules_for_event(event_id)

        for rule in rules:
            if not rule.is_active:
                continue
            if rule.trigger != trigger_type:
                continue

            # Check cooldown
            if rule.last_fired_at:
                last = datetime.fromisoformat(rule.last_fired_at)
                if datetime.now(timezone.utc) - last < timedelta(minutes=rule.cooldown_minutes):
                    continue

            # Evaluate conditions
            if rule.match_all:
                conditions_met = all(c.evaluate(context) for c in rule.conditions)
            else:
                conditions_met = any(c.evaluate(context) for c in rule.conditions)

            if not conditions_met:
                continue

            # Execute actions
            executed_actions = []
            for action in rule.actions:
                success = await _execute_action(action, event_id, context)
                if success:
                    executed_actions.append(action.type.value)

            # Update last_fired_at
            rule.last_fired_at = datetime.now(timezone.utc).isoformat()
            await update_rule(rule)

            # Log execution
            log = RuleExecutionLog(
                rule_id=rule.id,
                rule_name=rule.name,
                event_id=event_id,
                trigger=trigger_type.value,
                conditions_met=True,
                actions_executed=executed_actions,
                context_snapshot=context,
                executed_at=datetime.now(timezone.utc).isoformat(),
            )
            logs.append(log)

            # Store log in Redis
            log_key = f"v2:rules:logs:{event_id}"
            await redis.lpush(log_key, json.dumps({
                "rule_id": log.rule_id,
                "rule_name": log.rule_name,
                "trigger": log.trigger,
                "actions": log.actions_executed,
                "executed_at": log.executed_at,
            }))
            await redis.ltrim(log_key, 0, 99)  # Keep last 100 logs

    except Exception:
        pass

    return logs


async def _execute_action(action: Action, event_id: str, context: dict) -> bool:
    """Execute a single action. Returns True on success."""
    redis = get_redis()

    try:
        if action.type == ActionType.LOG_EVENT:
            if redis:
                await redis.lpush(
                    f"v2:rules:action_log:{event_id}",
                    json.dumps({
                        "action": action.type.value,
                        "params": action.params,
                        "context": {k: str(v) for k, v in context.items()},
                        "ts": datetime.now(timezone.utc).isoformat(),
                    }),
                )
            return True

        elif action.type == ActionType.NOTIFY_ORGANIZER:
            # Queue notification (actual implementation would use notification service)
            if redis:
                await redis.lpush(
                    "v2:rules:notifications",
                    json.dumps({
                        "type": "organizer",
                        "event_id": event_id,
                        "message": action.params.get("message", "자동 규칙 알림"),
                        "ts": datetime.now(timezone.utc).isoformat(),
                    }),
                )
            return True

        elif action.type == ActionType.NOTIFY_ADMIN:
            if redis:
                await redis.lpush(
                    "v2:rules:notifications",
                    json.dumps({
                        "type": "admin",
                        "event_id": event_id,
                        "message": action.params.get("message", "관리자 알림"),
                        "ts": datetime.now(timezone.utc).isoformat(),
                    }),
                )
            return True

        elif action.type == ActionType.FLAG_FOR_REVIEW:
            if redis:
                flagged_key = f"v2:rules:flagged:{event_id}"
                await _sadd_with_ttl(
                    redis,
                    flagged_key,
                    json.dumps({
                        "reason": action.params.get("reason", "자동 규칙 플래그"),
                        "ts": datetime.now(timezone.utc).isoformat(),
                    }),
                    ttl=FLAGGED_TTL,
                )
            return True

        elif action.type in (
            ActionType.ENABLE_WAITLIST,
            ActionType.DISABLE_WAITLIST,
            ActionType.APPLY_DISCOUNT,
            ActionType.REMOVE_DISCOUNT,
            ActionType.PAUSE_SALES,
            ActionType.RESUME_SALES,
            ActionType.SEND_PUSH,
        ):
            # Queue for async processing
            if redis:
                await redis.lpush(
                    "v2:rules:action_queue",
                    json.dumps({
                        "action": action.type.value,
                        "event_id": event_id,
                        "params": action.params,
                        "ts": datetime.now(timezone.utc).isoformat(),
                    }),
                )
            return True

        return False
    except Exception:
        return False


# ── Predefined Rule Templates ─────────────────────────────────────────────────

RULE_TEMPLATES = [
    {
        "name": "매진 임박 대기열 활성화",
        "description": "판매율 80% 초과 시 대기열을 자동 활성화합니다",
        "trigger": TriggerType.CAPACITY_THRESHOLD,
        "conditions": [
            Condition(field="sell_through_rate", operator=ConditionOperator.GT, value=0.8),
        ],
        "actions": [
            Action(type=ActionType.ENABLE_WAITLIST),
            Action(type=ActionType.NOTIFY_ORGANIZER, params={"message": "판매율 80% 초과 — 대기열 자동 활성화됨"}),
        ],
    },
    {
        "name": "막판 할인 적용",
        "description": "이벤트 24시간 전, 잔여율 50% 초과 시 15% 할인 자동 적용",
        "trigger": TriggerType.TIME_BEFORE_EVENT,
        "conditions": [
            Condition(field="hours_until_event", operator=ConditionOperator.LTE, value=24),
            Condition(field="unsold_rate", operator=ConditionOperator.GT, value=0.5),
        ],
        "actions": [
            Action(type=ActionType.APPLY_DISCOUNT, params={"percentage": 15, "label": "막판 할인"}),
            Action(type=ActionType.NOTIFY_ORGANIZER, params={"message": "막판 할인(15%)이 자동 적용되었습니다"}),
        ],
    },
    {
        "name": "이상 입찰 감지",
        "description": "입찰가가 티어 가격의 2배 초과 시 검토 플래그",
        "trigger": TriggerType.BID_PLACED,
        "conditions": [
            Condition(field="bid_to_price_ratio", operator=ConditionOperator.GT, value=2.0),
        ],
        "actions": [
            Action(type=ActionType.FLAG_FOR_REVIEW, params={"reason": "이상 입찰 감지"}),
            Action(type=ActionType.NOTIFY_ADMIN, params={"message": "이상 입찰 감지 — 검토 필요"}),
        ],
    },
    {
        "name": "높은 환불률 경고",
        "description": "환불률 10% 초과 시 주최자 알림",
        "trigger": TriggerType.REFUND_REQUESTED,
        "conditions": [
            Condition(field="refund_rate", operator=ConditionOperator.GT, value=0.1),
        ],
        "actions": [
            Action(type=ActionType.NOTIFY_ORGANIZER, params={"message": "환불률이 10%를 초과했습니다. 확인이 필요합니다."}),
            Action(type=ActionType.LOG_EVENT),
        ],
    },
]


def get_templates() -> list[dict]:
    """Get predefined rule templates for organizer UI."""
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "trigger": t["trigger"].value,
            "conditions": [c.to_dict() for c in t["conditions"]],
            "actions": [a.to_dict() for a in t["actions"]],
        }
        for t in RULE_TEMPLATES
    ]
