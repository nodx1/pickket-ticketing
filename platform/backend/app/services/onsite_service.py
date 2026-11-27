"""현장 단말 연동 입장 관리 (과업 WP6).

단말(키오스크·POS·게이트 스캐너)이 QR 을 보내면 아래 순서로 판정한다. 입장 자격 판정 자체는
기존 정본 `admission_service.admit()` 하나만 쓴다(두 벌 판정 금지 — 게이트마다 결과가 달라지면 안 된다).

    ① QR 해석      회전 QR(PKT:티켓번호:창:서명) 서명·시간창 검증. POS 수기 입력은 티켓번호 직접
    ② 행사 경계    단말의 이벤트 티켓인지
    ③ 차단 목록    주최사가 막은 티켓(분실·도난·부정 의심)                 → blocked_ticket
    ④ 제재 계정    티켓 소유자가 Slash 제재 중                              → sanctioned_account
    ⑤ 게이트 권한  단말 허용 등급에 없는 등급                                → gate_not_allowed
    ⑥ 캡처 재사용  이미 입장에 쓰인 같은 QR 화면이 다른 단말에서 2분 안에    → qr_replay
    ⑦ 중복 티켓    같은 티켓이 다른 게이트에서 60초 안에 다시               → duplicate_ticket
    ⑧ admit()      취소·만료·입장일 판정 + 원장(event_admissions) 기록

모든 판정은 ts_admission_events(TimescaleDB)에 남고, 실시간 게이트웨이로 대시보드·단말에 퍼진다.
부정 탐지(③④⑥⑦, 위조 QR)는 fraud 경보로 별도 방송되어 같은 이벤트의 모든 단말이 동기화된다.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.core.config import settings
from app.core.redis import get_redis
from app.models.event import Event, SeatTier
from app.models.onsite import AdmissionBlock, OnsiteTerminal, TerminalKind
from app.models.ticket import Ticket
from app.models.user import User
from app.services.admission_service import AdmissionError, admit
from app.services.timeseries_log import record_admission_event

logger = logging.getLogger(__name__)

QR_WINDOW_SECONDS = 30
QR_TOLERANCE_WINDOWS = 5  # go 와 같은 기본값(±150초)
# 피켓 앱·웹 티켓 QR(v2 서명 회전 QR) 유효 시간은 스태프 체크인과 같은 설정값(CHECKIN_QR_MAX_AGE_SECONDS, 60초)을 쓴다.
REPLAY_WINDOW_SECONDS = 120
DUPLICATE_GATE_SECONDS = 60
DUPLICATE_READ_SECONDS = 5
ONLINE_SECONDS = 60
KEY_PREFIX = "pkt_term_"
# 단말 키(= 직원 입장 링크)는 행사가 끝나고 이만큼 지나면 더 이상 통하지 않는다.
# 공연이 늦게 끝나거나 퇴장·재입장이 이어지는 경우를 넉넉히 덮는 값이다.
TERMINAL_CLOSE_GRACE = timedelta(hours=12)
# 직원 입장 링크를 새로 만들 수 있는 이벤트 상태(관리자 승인 뒤 ~ 추첨·배정 완료).
ENTRY_LINK_OPEN_STATUSES = frozenset({"approved", "bidding_open", "bidding_closed", "allocating", "allocated"})
TERMINAL_CLOSED_MESSAGE = "행사가 끝나 이 단말(입장 링크)은 닫혔습니다"

FRAUD_CODES = {"forged_qr", "blocked_ticket", "sanctioned_account", "qr_replay", "duplicate_ticket"}
MESSAGES = {
    "invalid_qr": "유효하지 않은 QR입니다. 화면의 회전 QR을 다시 제시해 주세요.",
    "forged_qr": "위조된 QR입니다. 직원에게 문의해 주세요.",
    "expired_qr": "QR이 만료되었습니다. 화면을 새로고침한 뒤 다시 스캔해 주세요.",
    "not_found": "티켓을 찾을 수 없습니다.",
    "wrong_event": "이 행사의 티켓이 아닙니다.",
    "blocked_ticket": "입장이 차단된 티켓입니다. 직원에게 문의해 주세요.",
    "sanctioned_account": "이용이 제한된 계정의 티켓입니다. 직원에게 문의해 주세요.",
    "gate_not_allowed": "이 게이트에서는 입장할 수 없는 등급입니다. 안내된 게이트를 이용해 주세요.",
    "qr_replay": "이미 입장에 사용된 QR 화면입니다(캡처 공유 의심). 직원에게 문의해 주세요.",
    "duplicate_ticket": "방금 다른 게이트에서 입장한 티켓입니다(중복 사용 의심).",
    "cancelled": "취소되었거나 만료된 티켓입니다.",
    "not_admission_day": "오늘은 입장 가능일이 아닙니다.",
    "manual_not_allowed": "이 단말은 수기 입력을 쓸 수 없습니다.",
}


class OnsiteError(ValueError):
    pass


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def _status_value(event: Event) -> str:
    return str(getattr(event.status, "value", event.status))


def terminal_closes_at(event: Event) -> datetime | None:
    """이 행사의 단말 키가 닫히는 시각 — 끝나는 시각(없으면 시작 시각) + 여유."""
    end = _aware(event.event_date_end) or _aware(event.event_date)
    return end + TERMINAL_CLOSE_GRACE if end else None


def event_closed_for_terminals(event: Event, now: datetime | None = None) -> bool:
    """행사가 취소됐거나 끝난 뒤 여유 시간까지 지났으면 True. 승인 전 리허설은 막지 않는다."""
    if _status_value(event) == "cancelled":
        return True
    closes = terminal_closes_at(event)
    return closes is not None and (now or _now()) >= closes


def entry_link_state(event: Event, now: datetime | None = None) -> dict:
    """피켓고 「직원 입장 링크」 칸에 보여 줄 상태 — 지금 새 링크를 만들 수 있는지와 그 이유."""
    closes = terminal_closes_at(event)
    status = _status_value(event)
    if event_closed_for_terminals(event, now):
        reason = "취소된 이벤트라 입장 링크를 만들 수 없어요." if status == "cancelled" else "행사가 끝나 입장 링크가 닫혔어요."
        return {"open": False, "reason": reason, "closes_at": closes.isoformat() if closes else None}
    if status == "completed":
        return {"open": False, "reason": "끝난 이벤트라 입장 링크를 만들 수 없어요.", "closes_at": closes.isoformat() if closes else None}
    if status not in ENTRY_LINK_OPEN_STATUSES:
        return {"open": False, "reason": "관리자 승인 뒤에 입장 링크를 만들 수 있어요.", "closes_at": closes.isoformat() if closes else None}
    return {"open": True, "reason": None, "closes_at": closes.isoformat() if closes else None}


def _mask(name: str | None) -> str:
    if not name:
        return "-"
    if len(name) <= 2:
        return name[0] + "*"
    return name[0] + "*" * (len(name) - 2) + name[-1]


def resolve_qr(payload: str, *, secret: str, now: float | None = None, tolerance: int = QR_TOLERANCE_WINDOWS) -> tuple[str, str | None]:
    """회전 QR 해석 — (상태, 티켓번호). 상태: ok | expired_qr | forged_qr | invalid_qr.

    go `lib/ticket/dynamic-qr.ts` 와 같은 규칙: HMAC-SHA256(QR_SECRET, "티켓번호:창")[:16].
    """
    if not payload.startswith("PKT:"):
        return "invalid_qr", None
    parts = payload.split(":")
    if len(parts) != 4 or not secret:
        return "invalid_qr", None
    _, ticket_no, window_text, sig = parts
    try:
        window = int(window_text)
    except ValueError:
        return "invalid_qr", None
    expected = hmac.new(secret.encode(), f"{ticket_no}:{window}".encode(), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(expected, sig):
        return "forged_qr", None
    current = int((now if now is not None else time.time()) // QR_WINDOW_SECONDS)
    if abs(current - window) > tolerance:
        return "expired_qr", ticket_no
    return "ok", ticket_no


async def resolve_pickket_qr(session: AsyncSession, payload: str) -> tuple[str, str | None]:
    """피켓(v2) 티켓 QR 해석 — (상태, 티켓번호). 피켓에서 예매한 티켓을 피켓고 현장 단말로 입장시킨다.

    🔴 예전 단말은 피켓고 형식(PKT:티켓번호:창:서명)만 받아, 피켓 앱·웹 티켓은 전부
       「유효하지 않은 QR」로 거부됐다(실측 2026-11-18: 가중치 추첨 당첨 → 결제 → 입장 불가).
    지원 형식(서버가 /tickets/{id}/qr 로 내려주는 그대로):
      ① 기기 묶인 TOTP  "티켓id|코드|기기해시"         — 티켓의 시드·기기해시로 검증
      ② 서명 회전 QR    base64("티켓id|시각|서명")     — QR_HMAC_SECRET, 60초
    """
    from app.services.dynamic_qr_service import TOTPQRService, verify_qr

    parts = payload.split("|")
    if len(parts) == 3:
        try:
            ticket_id = uuid.UUID(parts[0])
        except ValueError:
            return "invalid_qr", None
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None or not ticket.totp_seed or not ticket.device_hash:
            return "invalid_qr", None
        ok, err = TOTPQRService.verify_qr(payload, ticket.totp_seed, ticket.device_hash)
        if ok:
            return "ok", ticket.ticket_number
        return ("expired_qr" if err == "totp_expired" else "forged_qr"), ticket.ticket_number

    secret = settings.QR_HMAC_SECRET
    ticket_id = verify_qr(payload, secret, max_age_seconds=settings.CHECKIN_QR_MAX_AGE_SECONDS)
    if ticket_id is None:
        # 서명은 맞는데 오래됐으면 만료, 서명이 틀리면 위조(부정 경보), 형식부터 아니면 무효.
        stale = verify_qr(payload, secret, max_age_seconds=10 * 365 * 24 * 3600)
        if stale is not None:
            ticket = await session.get(Ticket, stale)
            return "expired_qr", ticket.ticket_number if ticket else None
        try:
            import base64

            looks_signed = len(base64.urlsafe_b64decode(payload.encode()).decode().split("|")) == 3
        except Exception:  # noqa: BLE001 — 형식 판별만
            looks_signed = False
        return ("forged_qr" if looks_signed else "invalid_qr"), None
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None or not ticket.ticket_number:
        return "invalid_qr", None
    return "ok", ticket.ticket_number


@dataclass
class ScanOutcome:
    result: str  # admitted | reentry_ok | rejected
    code: str
    message: str
    ticket_no: str | None = None
    holder: str | None = None
    tier: str | None = None
    gate: str | None = None
    terminal_id: str | None = None
    attended_date: str | None = None
    fraud: bool = False
    duplicate_read: bool = False
    at: str = field(default_factory=lambda: _now().isoformat())

    def to_dict(self) -> dict:
        return {
            "result": self.result,
            "code": self.code,
            "message": self.message,
            "ticket_no": self.ticket_no,
            "holder": self.holder,
            "tier": self.tier,
            "gate": self.gate,
            "terminal_id": self.terminal_id,
            "attended_date": self.attended_date,
            "fraud": self.fraud,
            "duplicate_read": self.duplicate_read,
            "at": self.at,
        }


class OnsiteService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ───────── 단말 등록부 ─────────

    async def register_terminal(
        self,
        event_id: uuid.UUID,
        *,
        name: str,
        kind: str,
        gate: str = "main",
        allowed_tier_ids: list[str] | None = None,
        actor: str | None = None,
    ) -> tuple[OnsiteTerminal, str]:
        """단말 등록. 평문 키는 이 응답에서 **한 번만** 돌려준다(DB 에는 해시만)."""
        if kind not in TerminalKind.ALL:
            raise OnsiteError(f"알 수 없는 단말 종류입니다: {kind}")
        if not name.strip():
            raise OnsiteError("단말 이름이 필요합니다")
        if await self.session.get(Event, event_id) is None:
            raise OnsiteError("이벤트를 찾을 수 없습니다")
        tiers = await self._validate_tiers(event_id, allowed_tier_ids or [])
        key = KEY_PREFIX + secrets.token_urlsafe(32)
        terminal = OnsiteTerminal(
            event_id=event_id,
            name=name.strip()[:80],
            kind=kind,
            gate=(gate or "main").strip()[:40],
            allowed_tier_ids=tiers,
            key_hash=hash_key(key),
            key_prefix=key[: len(KEY_PREFIX) + 4],
            status="active",
            created_by=actor,
            created_at=_now(),
            updated_at=_now(),
        )
        self.session.add(terminal)
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="onsite_terminal_registered",
            resource_type="onsite_terminal",
            resource_id=str(terminal.id),
            event_id=event_id,
            new_value={"name": terminal.name, "kind": kind, "gate": terminal.gate, "allowed_tier_ids": tiers, "actor": actor},
        )
        return terminal, key

    async def _validate_tiers(self, event_id: uuid.UUID, tier_ids: list[str]) -> list[str]:
        if not tier_ids:
            return []
        ids = [uuid.UUID(str(t)) for t in tier_ids]
        found = set(
            (await self.session.execute(select(SeatTier.id).where(SeatTier.event_id == event_id, SeatTier.id.in_(ids)))).scalars().all()
        )
        if len(found) != len(set(ids)):
            raise OnsiteError("이 이벤트의 등급이 아닌 값이 있습니다")
        return sorted(str(t) for t in found)

    async def update_terminal(
        self,
        terminal_id: uuid.UUID,
        *,
        event_id: uuid.UUID | None = None,
        gate: str | None = None,
        allowed_tier_ids: list[str] | None = None,
        status: str | None = None,
        actor: str | None = None,
    ) -> OnsiteTerminal:
        terminal = await self.session.get(OnsiteTerminal, terminal_id)
        if terminal is None or (event_id is not None and terminal.event_id != event_id):
            raise OnsiteError("단말을 찾을 수 없습니다")
        if terminal.status == "revoked":
            raise OnsiteError("폐기된 단말은 바꿀 수 없습니다")
        old = {"gate": terminal.gate, "allowed_tier_ids": terminal.allowed_tier_ids, "status": terminal.status}
        if gate is not None:
            terminal.gate = gate.strip()[:40] or "main"
        if allowed_tier_ids is not None:
            terminal.allowed_tier_ids = await self._validate_tiers(terminal.event_id, allowed_tier_ids)
        if status is not None:
            if status not in ("active", "suspended", "revoked"):
                raise OnsiteError("상태 값이 올바르지 않습니다")
            terminal.status = status
        terminal.updated_at = _now()
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="onsite_terminal_updated",
            resource_type="onsite_terminal",
            resource_id=str(terminal.id),
            event_id=terminal.event_id,
            old_value=old,
            new_value={"gate": terminal.gate, "allowed_tier_ids": terminal.allowed_tier_ids, "status": terminal.status, "actor": actor},
        )
        payload = {"terminal_id": str(terminal.id), "gate": terminal.gate, "allowed_tier_ids": list(terminal.allowed_tier_ids or []), "status": terminal.status}
        event_id = terminal.event_id
        _publish_after_commit(self.session, lambda: _publish("permission", event_id, payload))
        return terminal

    async def reissue_key(
        self, terminal_id: uuid.UUID, *, event_id: uuid.UUID, actor: str | None = None
    ) -> tuple[OnsiteTerminal, str]:
        """단말 키를 새로 발급한다(= 직원 입장 링크 새로 만들기). 예전 키는 그 즉시 통하지 않는다.

        키는 해시로만 저장하므로 예전 링크를 「다시 보여 주기」는 할 수 없다 — 새로 만들고 옛것을 끊는다.
        """
        terminal = await self.session.get(OnsiteTerminal, terminal_id)
        if terminal is None or terminal.event_id != event_id:
            raise OnsiteError("단말을 찾을 수 없습니다")
        if terminal.status == "revoked":
            raise OnsiteError("폐기된 단말은 새 링크를 만들 수 없습니다")
        event = await self.session.get(Event, event_id)
        if event is None:
            raise OnsiteError("이벤트를 찾을 수 없습니다")
        if event_closed_for_terminals(event):
            raise OnsiteError(TERMINAL_CLOSED_MESSAGE)
        key = KEY_PREFIX + secrets.token_urlsafe(32)
        old_prefix = terminal.key_prefix
        terminal.key_hash = hash_key(key)
        terminal.key_prefix = key[: len(KEY_PREFIX) + 4]
        terminal.updated_at = _now()
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="onsite_terminal_key_reissued",
            resource_type="onsite_terminal",
            resource_id=str(terminal.id),
            event_id=event_id,
            old_value={"key_prefix": old_prefix},
            new_value={"key_prefix": terminal.key_prefix, "actor": actor},
        )
        # 예전 키로 붙어 있던 기기는 바로 끊는다(다시 붙으려 하면 키가 맞지 않아 거부된다).
        payload = {
            "terminal_id": str(terminal.id),
            "gate": terminal.gate,
            "allowed_tier_ids": list(terminal.allowed_tier_ids or []),
            "status": terminal.status,
            "rekeyed": True,
        }
        _publish_after_commit(self.session, lambda: _publish("permission", event_id, payload))
        return terminal, key

    async def check_key(self, key: str | None) -> tuple[OnsiteTerminal | None, str]:
        """단말 키 확인 — (단말, 이유). 이유: ok | unknown | inactive | event_closed."""
        if not key or not key.startswith(KEY_PREFIX):
            return None, "unknown"
        terminal = await self.session.scalar(select(OnsiteTerminal).where(OnsiteTerminal.key_hash == hash_key(key)))
        if not isinstance(terminal, OnsiteTerminal):
            return None, "unknown"
        if terminal.status != "active":
            return None, "inactive"
        event = await self.session.get(Event, terminal.event_id)
        if event is None or event_closed_for_terminals(event):
            return None, "event_closed"
        return terminal, "ok"

    async def authenticate(self, key: str | None) -> OnsiteTerminal | None:
        terminal, _ = await self.check_key(key)
        return terminal

    async def heartbeat(self, terminal: OnsiteTerminal) -> None:
        terminal.last_seen_at = _now()
        await self.session.flush()

    # ───────── 차단 목록 ─────────

    async def set_block(self, event_id: uuid.UUID, ticket_number: str, *, block: bool, reason: str, actor: str | None) -> AdmissionBlock:
        ticket = await self.session.scalar(select(Ticket).where(Ticket.ticket_number == ticket_number))
        if ticket is None or ticket.event_id != event_id:
            raise OnsiteError("이 행사의 티켓번호가 아닙니다")
        row = AdmissionBlock(
            event_id=event_id,
            ticket_number=ticket_number,
            action="block" if block else "unblock",
            reason=reason[:200],
            created_by=actor,
            created_at=_now(),
        )
        self.session.add(row)
        await self.session.flush()
        _publish_after_commit(self.session, lambda: _publish_fresh_blocklist(event_id))
        return row

    async def _blocked_numbers(self, event_id: uuid.UUID) -> dict[str, str]:
        rows = (
            await self.session.execute(
                select(AdmissionBlock.ticket_number, AdmissionBlock.action, AdmissionBlock.reason)
                .where(AdmissionBlock.event_id == event_id)
                .order_by(AdmissionBlock.created_at)
            )
        ).all()
        state: dict[str, str] = {}
        for number, action, reason in rows:
            if action == "block":
                state[number] = reason or "차단"
            else:
                state.pop(number, None)
        return state

    async def blocklist(self, event_id: uuid.UUID) -> dict:
        """단말 동기화용 — 차단 티켓 + 제재 계정 소유 티켓."""
        from app.services.sanction_service import SanctionService

        blocked = await self._blocked_numbers(event_id)
        owners = (
            await self.session.execute(
                select(Ticket.ticket_number, Ticket.current_owner_id).where(
                    Ticket.event_id == event_id, Ticket.ticket_number.is_not(None)
                )
            )
        ).all()
        sanctioned_users = await SanctionService(self.session).disqualified_among(
            list({o.current_owner_id for o in owners if o.current_owner_id}), event_id
        )
        sanctioned = sorted(o.ticket_number for o in owners if o.current_owner_id in sanctioned_users)
        return {
            "event_id": str(event_id),
            "version": int(time.time()),
            "blocked": [{"ticket_no": k, "reason": v} for k, v in sorted(blocked.items())],
            "sanctioned": sanctioned,
        }

    # ───────── 스캔 ─────────

    async def scan(
        self,
        terminal: OnsiteTerminal,
        payload: str,
        *,
        manual: bool = False,
        scanned_at: datetime | None = None,
    ) -> ScanOutcome:
        now = _now()
        gate = terminal.gate
        base = {"gate": gate, "terminal_id": str(terminal.id)}
        payload = (payload or "").strip()

        # ① QR 해석
        if manual:
            if terminal.kind == TerminalKind.GATE_SCANNER:
                return await self._finish(terminal, ScanOutcome("rejected", "manual_not_allowed", MESSAGES["manual_not_allowed"], **base))
            ticket_no = payload.upper()
        else:
            if payload.startswith("PKT:"):
                status, ticket_no = resolve_qr(payload, secret=settings.GO_QR_SECRET)
            else:
                status, ticket_no = await resolve_pickket_qr(self.session, payload)
            if status != "ok":
                return await self._finish(
                    terminal,
                    ScanOutcome("rejected", status, MESSAGES[status], ticket_no=ticket_no, fraud=status == "forged_qr", **base),
                )

        ticket = await self.session.scalar(select(Ticket).where(Ticket.ticket_number == ticket_no))
        if ticket is None:
            return await self._finish(terminal, ScanOutcome("rejected", "not_found", MESSAGES["not_found"], ticket_no=ticket_no, **base))
        # ② 행사 경계
        if ticket.event_id != terminal.event_id:
            return await self._finish(terminal, ScanOutcome("rejected", "wrong_event", MESSAGES["wrong_event"], ticket_no=ticket_no, **base))

        owner = await self.session.get(User, ticket.current_owner_id) if ticket.current_owner_id else None
        tier = await self.session.get(SeatTier, ticket.tier_id) if ticket.tier_id else None
        info = {"ticket_no": ticket_no, "holder": _mask(owner.name if owner else None), "tier": tier.name if tier else None, **base}

        # ③ 차단 목록
        blocked = await self._blocked_numbers(terminal.event_id)
        if ticket_no in blocked:
            return await self._finish(terminal, ScanOutcome("rejected", "blocked_ticket", MESSAGES["blocked_ticket"], fraud=True, **info))
        # ④ 제재 계정
        if ticket.current_owner_id:
            from app.services.sanction_service import SanctionService

            if await SanctionService(self.session).active_sanction(ticket.current_owner_id, terminal.event_id):
                return await self._finish(terminal, ScanOutcome("rejected", "sanctioned_account", MESSAGES["sanctioned_account"], fraud=True, **info))
        # ⑤ 게이트 권한
        if terminal.allowed_tier_ids and str(ticket.tier_id) not in terminal.allowed_tier_ids:
            return await self._finish(terminal, ScanOutcome("rejected", "gate_not_allowed", MESSAGES["gate_not_allowed"], **info))

        redis = _redis()
        qr_key = f"v2:onsite:qr:{{{terminal.event_id}}}:{hashlib.sha256(payload.encode()).hexdigest()}"
        last_key = f"v2:onsite:last:{{{terminal.event_id}}}:{ticket_no}"
        # ⑥ 캡처 재사용 (QR 스캔만)
        if redis is not None and not manual:
            prior_raw = await _safe(redis.get(qr_key))
            if prior_raw:
                prior = json.loads(prior_raw)
                age = now.timestamp() - float(prior["ts"])
                if prior["terminal_id"] == str(terminal.id) and age <= DUPLICATE_READ_SECONDS:
                    cached = ScanOutcome(**{**prior["outcome"], "duplicate_read": True})
                    return cached  # 같은 단말의 연속 판독 — 새 입장 아님
                if age <= REPLAY_WINDOW_SECONDS:
                    return await self._finish(terminal, ScanOutcome("rejected", "qr_replay", MESSAGES["qr_replay"], fraud=True, **info))
        # ⑦ 중복 티켓 (다른 게이트 짧은 간격)
        if redis is not None:
            last_raw = await _safe(redis.get(last_key))
            if last_raw:
                last = json.loads(last_raw)
                if last["gate"] != gate and now.timestamp() - float(last["ts"]) <= DUPLICATE_GATE_SECONDS:
                    return await self._finish(terminal, ScanOutcome("rejected", "duplicate_ticket", MESSAGES["duplicate_ticket"], fraud=True, **info))

        # ⑧ 정본 판정
        event = await self.session.get(Event, ticket.event_id)
        at = min(_aware(scanned_at) or now, now)
        try:
            result = await admit(self.session, ticket, event, at, method="terminal" if not manual else "manual")
        except AdmissionError as exc:
            code = {"NOT_ADMITTABLE": "cancelled", "NOT_ADMISSION_DAY": "not_admission_day"}.get(exc.code, "not_admission_day")
            return await self._finish(terminal, ScanOutcome("rejected", code, exc.message or MESSAGES[code], **info))

        outcome = ScanOutcome(
            result.outcome,
            result.outcome,
            "입장 확인" if result.outcome == "admitted" else "재입장 확인",
            attended_date=result.attended_date.isoformat(),
            **info,
        )
        if redis is not None:
            record = json.dumps({"terminal_id": str(terminal.id), "gate": gate, "ts": now.timestamp(), "outcome": outcome.to_dict()})
            await _safe(redis.set(qr_key, record, ex=REPLAY_WINDOW_SECONDS * 5))
            await _safe(redis.set(last_key, record, ex=24 * 3600))
        return await self._finish(terminal, outcome)

    async def _finish(self, terminal: OnsiteTerminal, outcome: ScanOutcome) -> ScanOutcome:
        terminal.last_seen_at = _now()
        await record_admission_event(
            self.session,
            event_id=terminal.event_id,
            result=outcome.result,
            terminal_id=terminal.id,
            gate=terminal.gate,
            ticket_ref=outcome.ticket_no,
            reason=outcome.code,
            meta={"fraud": outcome.fraud, "kind": terminal.kind},
        )
        await self._ledger(terminal, outcome)
        await self.session.flush()
        await _publish("admission", terminal.event_id, outcome.to_dict())
        if outcome.fraud:
            await _publish("fraud", terminal.event_id, {**outcome.to_dict(), "terminal_name": terminal.name})
        return outcome

    async def _ledger(self, terminal: OnsiteTerminal, outcome: ScanOutcome) -> None:
        """외부 연동 원장(과업 WP7). 원장 모듈이 없으면 건너뛴다."""
        try:
            from app.services.integration_ledger import record_integration
        except ImportError:
            return
        await record_integration(
            self.session,
            counterpart="terminal",
            counterpart_id=str(terminal.id),
            direction="inbound",
            operation="scan",
            event_id=terminal.event_id,
            request={"gate": terminal.gate, "kind": terminal.kind, "ticket_no": outcome.ticket_no},
            response={"result": outcome.result, "code": outcome.code, "fraud": outcome.fraud},
            status="ok" if outcome.result != "rejected" else "rejected",
        )

    # ───────── 대시보드 ─────────

    async def overview(self, event_id: uuid.UUID) -> dict:
        terminals = (
            await self.session.execute(select(OnsiteTerminal).where(OnsiteTerminal.event_id == event_id).order_by(OnsiteTerminal.created_at))
        ).scalars().all()
        tiers = {
            str(t.id): t.name for t in (await self.session.execute(select(SeatTier).where(SeatTier.event_id == event_id))).scalars().all()
        }
        now = _now()
        counts: dict[str, int] = {}
        by_gate: dict[str, dict[str, int]] = {}
        recent: list[dict] = []
        if self.session.get_bind().dialect.name == "postgresql":
            since = now - timedelta(hours=24)
            for gate, result, reason, n in (
                await self.session.execute(
                    text(
                        "SELECT gate, result, reason, count(*) FROM ts_admission_events "
                        "WHERE event_id = :e AND time >= :since GROUP BY gate, result, reason"
                    ),
                    {"e": event_id, "since": since},
                )
            ).all():
                key = result if result != "rejected" else f"rejected:{reason}"
                counts[key] = counts.get(key, 0) + int(n)
                g = by_gate.setdefault(gate or "-", {"admitted": 0, "reentry_ok": 0, "rejected": 0})
                g[result] = g.get(result, 0) + int(n)
            for row in (
                await self.session.execute(
                    text(
                        "SELECT time, gate, ticket_ref, result, reason, meta FROM ts_admission_events "
                        "WHERE event_id = :e ORDER BY time DESC LIMIT 50"
                    ),
                    {"e": event_id},
                )
            ).all():
                recent.append(
                    {
                        "at": row.time.isoformat(),
                        "gate": row.gate,
                        "ticket_no": row.ticket_ref,
                        "result": row.result,
                        "code": row.reason,
                        "message": MESSAGES.get(row.reason, ""),
                        "fraud": bool((row.meta or {}).get("fraud")),
                    }
                )
        admitted_people = await self.session.scalar(
            text("SELECT count(DISTINCT ticket_id) FROM event_admissions WHERE event_id = :e"), {"e": event_id}
        ) if self.session.get_bind().dialect.name == "postgresql" else None
        total_tickets = await self.session.scalar(select(func.count()).select_from(Ticket).where(Ticket.event_id == event_id))
        event = await self.session.get(Event, event_id)
        return {
            "event_id": str(event_id),
            "entry_link": entry_link_state(event, now) if event is not None else {"open": False, "reason": "이벤트를 찾을 수 없어요.", "closes_at": None},
            "totals": {"tickets": int(total_tickets or 0), "admitted_tickets": int(admitted_people or 0), "by_result": counts},
            "by_gate": by_gate,
            "terminals": [
                {
                    "id": str(t.id),
                    "name": t.name,
                    "kind": t.kind,
                    "kind_label": TerminalKind.LABEL.get(t.kind, t.kind),
                    "gate": t.gate,
                    "allowed_tiers": [{"id": tid, "name": tiers.get(tid, "")} for tid in (t.allowed_tier_ids or [])],
                    "status": t.status,
                    "online": bool(t.last_seen_at and (now - _aware(t.last_seen_at)).total_seconds() <= ONLINE_SECONDS),
                    "last_seen_at": _aware(t.last_seen_at).isoformat() if t.last_seen_at else None,
                    "key_prefix": t.key_prefix + "…",
                }
                for t in terminals
            ],
            "tiers": [{"id": k, "name": v} for k, v in tiers.items()],
            "recent": recent,
            "blocklist": await self.blocklist(event_id),
        }


def _redis():
    try:
        return get_redis()
    except Exception:  # noqa: BLE001
        return None


async def _safe(awaitable):
    try:
        return await awaitable
    except Exception:
        logger.warning("onsite redis op failed", exc_info=True)
        return None


async def _publish(kind: str, event_id: uuid.UUID, payload: dict) -> None:
    try:
        from app.realtime import gateway
    except ImportError:
        return
    try:
        await gateway.publish(kind, event_id, payload)
    except Exception:
        logger.warning("realtime publish failed (%s)", kind, exc_info=True)


def _publish_after_commit(session: AsyncSession, factory) -> None:
    try:
        from app.realtime.gateway import publish_after_commit
    except ImportError:
        return
    publish_after_commit(session, factory)


async def _publish_fresh_blocklist(event_id: uuid.UUID) -> None:
    """커밋된 상태로 차단 목록을 다시 만들어 단말에 보낸다."""
    from app.realtime import gateway

    async with gateway.session_factory() as db:
        await _publish("blocklist", event_id, await OnsiteService(db).blocklist(event_id))
