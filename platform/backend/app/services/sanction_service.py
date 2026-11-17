"""계정 제재(Slash)와 계정 복제 차단 (과업 WP2).

Slash 가 하는 일 (impose)
    ① AP 소각     보유 FAN AP 의 burn_ratio 만큼 DEDUCT_FRAUD 로 소각(잔액 0 아래로는 안 내려감)
    ② 자격 박탈   disqualify_until 까지 응모 거부
    ③ 추첨 제외   마감 전 진행 중 응모는 응모 Merkle 트리에 가중치 0·excluded 로 남고 추첨에서 빠짐
                  (투입 AP 는 환급되지 않음 — 소각)
    ④ 기록        account_sanctions(append-only) + 감사 로그 + 시계열(kind=slash)

계정 복제 차단 (check_apply)
    같은 이벤트에서 같은 기기 지문으로 응모한 다른 계정 수를 센다.
      · 기기 공유 ≥ DEVICE_BLOCK_THRESHOLD → 응모 거부 + 검토 표시(flag)
      · 기기 공유 1건 + 같은 IP 다수 → 거부하지 않고 검토 표시
      · 같은 IP 다수만(통신사 NAT·공연장 와이파이) → 기록만(anomaly_logs), 표시 안 함
    본인인증 CI 중복은 users.ci_hash UNIQUE 로 가입 단계에서 이미 막힌다.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.models.point import PointTransactionType, PointType
from app.models.sanction import AccountSanction, SanctionAction, SanctionReason
from app.models.user import User
from app.services.anomaly import AnomalyResult
from app.services.anomaly_tracker import AnomalyTracker
from app.services.timeseries_log import pseudonym, record_lottery_event

logger = logging.getLogger(__name__)

DEVICE_BLOCK_THRESHOLD = 2  # 같은 기기에서 이미 2개 계정이 응모했으면 3번째부터 거부
IP_FLAG_THRESHOLD = 5
DEFAULT_DISQUALIFY_DAYS = {
    SanctionReason.MACRO_BOT: 90,
    SanctionReason.MULTI_ACCOUNT: 180,
    SanctionReason.TICKET_FRAUD: 180,
    SanctionReason.SCALPING: 90,
    SanctionReason.MANUAL: 30,
}


class SanctionError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


class SanctionService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ───────── 조회 ─────────

    async def _rows_for(self, user_ids: list[uuid.UUID], event_id: uuid.UUID | None) -> list[AccountSanction]:
        if not user_ids:
            return []
        scope = AccountSanction.event_id.is_(None)
        if event_id is not None:
            scope = or_(scope, AccountSanction.event_id == event_id)
        result = await self.session.execute(
            select(AccountSanction)
            .where(AccountSanction.user_id.in_(user_ids), scope)
            .order_by(AccountSanction.created_at)
        )
        rows = result.scalars().all()
        return [r for r in rows if isinstance(r, AccountSanction)]

    @staticmethod
    def _active_impositions(rows: list[AccountSanction], now: datetime) -> list[AccountSanction]:
        lifted = {r.related_id for r in rows if r.action == SanctionAction.LIFT and r.related_id}
        return [
            r
            for r in rows
            if r.action == SanctionAction.IMPOSE
            and r.id not in lifted
            and (r.disqualify_until is None or _aware(r.disqualify_until) > now)
        ]

    async def disqualified_among(self, user_ids: list[uuid.UUID], event_id: uuid.UUID | None) -> set[uuid.UUID]:
        rows = await self._rows_for(list(user_ids), event_id)
        return {r.user_id for r in self._active_impositions(rows, _now())}

    async def active_sanction(self, user_id: uuid.UUID, event_id: uuid.UUID | None) -> AccountSanction | None:
        active = self._active_impositions(await self._rows_for([user_id], event_id), _now())
        return active[-1] if active else None

    # ───────── 부과·표시·해제 ─────────

    async def impose(
        self,
        user_id: uuid.UUID,
        reason_code: str,
        *,
        event_id: uuid.UUID | None = None,
        evidence: dict | None = None,
        burn_ratio: float = 1.0,
        disqualify_days: int | None = None,
        actor: str | None = None,
    ) -> AccountSanction:
        if reason_code not in SanctionReason.ALL:
            raise SanctionError(f"알 수 없는 제재 사유입니다: {reason_code}")
        if not 0 <= burn_ratio <= 1:
            raise SanctionError("소각 비율은 0~1 이어야 합니다")
        user = await self.session.get(User, user_id)
        if user is None:
            raise SanctionError("사용자를 찾을 수 없습니다")

        from app.services.point_service import PointService

        points = PointService(self.session)
        balance = await points.get_balance(user_id, PointType.FAN)
        to_burn = int(balance * burn_ratio)
        burned = 0
        if to_burn > 0:
            tx = await points.deduct(
                user_id=user_id,
                point_type=PointType.FAN,
                amount=to_burn,
                tx_type=PointTransactionType.DEDUCT_FRAUD,
                reference_id=event_id,
                description=f"부정 이용 제재 소각 ({SanctionReason.LABEL[reason_code]})",
                allow_overdraft=True,
            )
            burned = balance - await points.get_balance(user_id, PointType.FAN)
            del tx

        days = disqualify_days if disqualify_days is not None else DEFAULT_DISQUALIFY_DAYS[reason_code]
        row = AccountSanction(
            user_id=user_id,
            event_id=event_id,
            action=SanctionAction.IMPOSE,
            reason_code=reason_code,
            evidence=evidence or {},
            ap_burned=burned,
            disqualify_until=_now() + timedelta(days=days) if days > 0 else None,
            created_by=actor,
            created_at=_now(),
        )
        self.session.add(row)
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="account_slash",
            resource_type="account_sanction",
            resource_id=str(row.id),
            event_id=event_id,
            new_value={
                "user": pseudonym(user_id),
                "reason_code": reason_code,
                "ap_burned": burned,
                "disqualify_until": row.disqualify_until.isoformat() if row.disqualify_until else None,
                "actor": actor,
            },
        )
        if event_id is not None:
            await record_lottery_event(
                self.session, event_id=event_id, kind="slash", user_id=user_id, ap=burned, meta={"reason": reason_code}
            )
        await self._publish(row)
        return row

    async def flag(
        self,
        user_id: uuid.UUID,
        reason_code: str,
        *,
        event_id: uuid.UUID | None,
        evidence: dict | None = None,
        actor: str | None = "system",
    ) -> AccountSanction:
        row = AccountSanction(
            user_id=user_id,
            event_id=event_id,
            action=SanctionAction.FLAG,
            reason_code=reason_code,
            evidence=evidence or {},
            ap_burned=0,
            created_by=actor,
            created_at=_now(),
        )
        self.session.add(row)
        await self.session.flush()
        await self._publish(row)
        return row

    async def lift(self, sanction_id: uuid.UUID, *, actor: str | None, note: str = "") -> AccountSanction:
        original = await self.session.get(AccountSanction, sanction_id)
        if not isinstance(original, AccountSanction) or original.action != SanctionAction.IMPOSE:
            raise SanctionError("해제할 제재를 찾을 수 없습니다")
        row = AccountSanction(
            user_id=original.user_id,
            event_id=original.event_id,
            action=SanctionAction.LIFT,
            reason_code=original.reason_code,
            evidence={"note": note},
            ap_burned=0,
            related_id=original.id,
            created_by=actor,
            created_at=_now(),
        )
        self.session.add(row)
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="account_slash_lifted",
            resource_type="account_sanction",
            resource_id=str(original.id),
            event_id=original.event_id,
            new_value={"lift_id": str(row.id), "actor": actor, "note": note},
        )
        return row

    async def _publish(self, row: AccountSanction) -> None:
        """현장 단말·대시보드 실시간 동기화(과업 WP6) — **커밋 후** 방송한다.

        커밋 전에 방송하면 차단 목록을 다시 읽는 다른 세션이 이 제재를 못 본다.
        """
        try:
            from app.realtime.gateway import publish_after_commit, publish_sanction
        except ImportError:
            return
        snapshot = AccountSanction(
            id=row.id,
            user_id=row.user_id,
            event_id=row.event_id,
            action=row.action,
            reason_code=row.reason_code,
            ap_burned=row.ap_burned,
        )
        publish_after_commit(self.session, lambda: publish_sanction(snapshot))

    # ───────── 계정 복제 차단 ─────────

    async def check_apply(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        *,
        ip_address: str | None,
        device_fingerprint: str | None,
    ) -> None:
        """응모 직전 검사. 거부해야 하면 SanctionError, 아니면 기록만 남긴다."""
        active = await self.active_sanction(user_id, event_id)
        if active is not None:
            until = _aware(active.disqualify_until)
            until_text = until.astimezone(UTC).strftime("%Y-%m-%d") if until else "무기한"
            raise SanctionError(
                f"이용이 제한된 계정입니다 (사유: {SanctionReason.LABEL.get(active.reason_code, active.reason_code)}, "
                f"해제 예정: {until_text})"
            )
        if not ip_address and not device_fingerprint:
            return

        tracker = AnomalyTracker(self.session)
        same_device = await tracker.get_same_device_user_count(event_id, device_fingerprint, user_id)
        same_ip = await tracker.get_same_ip_user_count(event_id, ip_address, user_id)
        reasons: list[str] = []
        if same_device >= DEVICE_BLOCK_THRESHOLD:
            reasons.append(f"same_device_accounts={same_device + 1}")
        if same_ip >= IP_FLAG_THRESHOLD:
            reasons.append(f"same_ip_accounts={same_ip + 1}")
        blocked = same_device >= DEVICE_BLOCK_THRESHOLD
        await tracker.log_anomaly_check(
            user_id=user_id,
            event_id=event_id,
            result=AnomalyResult(is_anomalous=blocked, score=min(1.0, (same_device + same_ip / 5) / 3), reasons=reasons),
            ip_address=ip_address,
            fingerprint_hash=device_fingerprint,
        )
        # 🔴 검토 표시는 **기기 신호가 있을 때만** 남긴다(실측 2026-11-17).
        #    IP 하나만으로 표시하면 공연장 와이파이·통신사 NAT 뒤의 정상 관객이 전부 '검토 필요'로
        #    쌓여 모니터링이 쓸모없어진다. 같은 IP 다수는 anomaly_logs 에만 남긴다.
        needs_review = blocked or (same_device >= 1 and same_ip >= IP_FLAG_THRESHOLD)
        if needs_review:
            await self.flag(
                user_id,
                SanctionReason.MULTI_ACCOUNT,
                event_id=event_id,
                evidence={"same_device_accounts": same_device + 1, "same_ip_accounts": same_ip + 1, "blocked": blocked},
            )
        if blocked:
            # 거부해도 탐지 기록·검토 표시는 남아야 한다(호출자 트랜잭션은 이후 롤백된다)
            await self.session.commit()
            raise SanctionError("같은 기기에서 여러 계정으로 응모할 수 없습니다")

    # ───────── 모니터링 ─────────

    async def monitor(self, event_id: uuid.UUID, limit: int = 200) -> dict:
        rows = (
            await self.session.execute(
                select(AccountSanction, User.name)
                .join(User, User.id == AccountSanction.user_id)
                .where(or_(AccountSanction.event_id == event_id, AccountSanction.event_id.is_(None)))
                .order_by(AccountSanction.created_at.desc())
                .limit(limit)
            )
        ).all()
        now = _now()
        all_rows = [r[0] for r in rows]
        lifted = {r.related_id for r in all_rows if r.action == SanctionAction.LIFT}
        counts = dict(
            (
                await self.session.execute(
                    select(AccountSanction.action, func.count())
                    .where(and_(AccountSanction.event_id == event_id))
                    .group_by(AccountSanction.action)
                )
            ).all()
        )
        return {
            "event_id": str(event_id),
            "counts": {k: int(v) for k, v in counts.items()},
            "items": [
                {
                    "id": str(s.id),
                    "user": pseudonym(s.user_id),
                    "name": _mask(name),
                    "scope": "event" if s.event_id else "platform",
                    "action": s.action,
                    "reason_code": s.reason_code,
                    "reason_label": SanctionReason.LABEL.get(s.reason_code, s.reason_code),
                    "ap_burned": s.ap_burned,
                    "disqualify_until": _aware(s.disqualify_until).isoformat() if s.disqualify_until else None,
                    "active": s.action == SanctionAction.IMPOSE
                    and s.id not in lifted
                    and (s.disqualify_until is None or _aware(s.disqualify_until) > now),
                    "lifted": s.id in lifted,
                    "evidence": s.evidence,
                    "created_by": s.created_by,
                    "created_at": _aware(s.created_at).isoformat() if s.created_at else None,
                }
                for s, name in rows
            ],
        }


def _mask(name: str | None) -> str:
    if not name:
        return "-"
    return name[0] + "*" * max(1, len(name) - 1)
