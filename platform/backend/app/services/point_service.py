"""Point service for earning, spending, and querying points.

Manages the dual-wallet system (Fan Points + Social Points) and provides
lottery weight computation based on point balances.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.point import (
    PointWallet,
    PointTransaction,
    PointType,
    PointTransactionType,
)

# WP07: 구매 기반 tx_type — 추첨 가중치 산출 시 제외
PURCHASE_BASED_TYPES = {
    PointTransactionType.EARN_PURCHASE,
    PointTransactionType.EARN_GOODS,
}

# WP22: 도메인별 특화 AP 적립 정책
DOMAIN_SPECIAL_AP: dict[str, dict[str, int]] = {
    "concert": {"fanclub_official": 500, "fanclub_unofficial": 300},
    "sports": {"season_ticket": 1000, "consecutive_home_3": 200},
    "musical": {"rewatch": 100},
    "classical": {"season_subscription": 800},
    "exhibition": {"education_program": 150},
    "festival": {"earlybird": 100},
    "education": {"student_verification": 300},
    "civic": {"residency_verification": 500},
}


class PointAnomalyDetector:
    """포인트 이상 거래 패턴 탐지 — 3중 검증.

    Detects abnormal point transaction patterns:
    1. Rapid earn: >500 points earned within 24 hours
    2. Spend-after-earn: Spending within 5 minutes of earning (cycling)
    3. Cyclic trading: A→B→A transfer pattern detection

    Each detector returns a boolean flag; compute_anomaly_score()
    returns a composite score in [0.0, 1.0].
    """

    RAPID_EARN_THRESHOLD = 500
    RAPID_EARN_WINDOW_HOURS = 24
    SPEND_AFTER_EARN_MIN_GAP_MINUTES = 5

    @staticmethod
    def detect_rapid_earn(
        recent_transactions: list[dict],
        window_hours: int = 24,
        threshold: float = 500,
    ) -> bool:
        """Detect rapid point accumulation within time window.

        Returns True if total earned exceeds threshold within window.
        """
        from datetime import datetime, timedelta, timezone

        cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)
        earned = sum(
            tx.get("amount", 0)
            for tx in recent_transactions
            if tx.get("amount", 0) > 0 and tx.get("created_at", cutoff) >= cutoff
        )
        return earned > threshold

    @staticmethod
    def detect_spend_after_earn(
        recent_transactions: list[dict],
        min_gap_minutes: int = 5,
    ) -> bool:
        """Detect suspicious spend immediately after earn.

        Returns True if any deduction occurs within min_gap_minutes
        of a credit transaction.
        """

        credits = [tx for tx in recent_transactions if tx.get("amount", 0) > 0]
        debits = [tx for tx in recent_transactions if tx.get("amount", 0) < 0]

        for credit in credits:
            credit_time = credit.get("created_at")
            if not credit_time:
                continue
            for debit in debits:
                debit_time = debit.get("created_at")
                if not debit_time:
                    continue
                gap = abs((debit_time - credit_time).total_seconds()) / 60.0
                if gap < min_gap_minutes:
                    return True
        return False

    @staticmethod
    def detect_cyclic_trading(
        user_id: str,
        transfer_history: list[dict],
    ) -> bool:
        """Detect cyclic point transfer pattern (A→B→A).

        Returns True if circular transfer detected.
        """
        # Build transfer graph
        sent_to = set()
        received_from = set()

        for tx in transfer_history:
            if str(tx.get("from_user")) == str(user_id):
                sent_to.add(str(tx.get("to_user")))
            elif str(tx.get("to_user")) == str(user_id):
                received_from.add(str(tx.get("from_user")))

        # Circular if any user appears in both sets
        return bool(sent_to & received_from)

    @staticmethod
    def compute_anomaly_score(
        rapid_earn: bool = False,
        spend_after_earn: bool = False,
        cyclic_trading: bool = False,
    ) -> float:
        """Compute composite anomaly score.

        Returns:
            Score in [0.0, 1.0] where higher = more suspicious.
        """
        weights = {
            "rapid_earn": 0.3,
            "spend_after_earn": 0.4,
            "cyclic_trading": 0.3,
        }
        score = 0.0
        if rapid_earn:
            score += weights["rapid_earn"]
        if spend_after_earn:
            score += weights["spend_after_earn"]
        if cyclic_trading:
            score += weights["cyclic_trading"]
        return score


class PointService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create_wallets(self, user_id: uuid.UUID) -> tuple[PointWallet, PointWallet]:
        """Create Fan + Social wallets for a new user with 100pt signup bonus each."""
        wallets: list[PointWallet] = []
        for pt in [PointType.FAN, PointType.SOCIAL]:
            wallet = PointWallet(
                user_id=user_id,
                point_type=pt,
                balance=100,
                lifetime_earned=100,
            )
            self.session.add(wallet)
            await self.session.flush()  # ensure wallet.id is populated

            tx = PointTransaction(
                wallet_id=wallet.id,
                user_id=user_id,
                tx_type=PointTransactionType.EARN_SIGNUP,
                amount=100,
                balance_after=100,
                description="회원가입 보너스",
            )
            self.session.add(tx)
            wallets.append(wallet)

        await self.session.flush()
        return wallets[0], wallets[1]

    async def get_wallet(
        self,
        user_id: uuid.UUID,
        point_type: PointType,
        *,
        for_update: bool = False,
    ) -> PointWallet | None:
        stmt = select(PointWallet).where(
            PointWallet.user_id == user_id,
            PointWallet.point_type == point_type,
        )
        if for_update:
            stmt = stmt.with_for_update()
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_balance(self, user_id: uuid.UUID, point_type: PointType) -> int:
        wallet = await self.get_wallet(user_id, point_type)
        return wallet.balance if wallet else 0

    async def get_all_balances(self, user_id: uuid.UUID) -> dict[str, int]:
        result = await self.session.execute(
            select(PointWallet).where(PointWallet.user_id == user_id)
        )
        wallets = result.scalars().all()
        return {w.point_type.value: w.balance for w in wallets}

    async def get_activity_only_balance(self, user_id: uuid.UUID, point_type: PointType) -> int:
        """구매 기반 AP를 제외한 순수 활동 기반 잔액.

        EARN_PURCHASE, EARN_GOODS 유형 거래를 제외하고 전체 거래 금액을 합산하여
        활동으로만 획득한 실질 잔액을 반환합니다.
        이 값은 추첨 가중치 산출에 사용됩니다.
        """
        wallet = await self.get_wallet(user_id, point_type)
        if not wallet:
            return 0

        result = await self.session.execute(
            select(func.coalesce(func.sum(PointTransaction.amount), 0)).where(
                PointTransaction.wallet_id == wallet.id,
                PointTransaction.tx_type.not_in([t.value for t in PURCHASE_BASED_TYPES]),
            )
        )
        return max(0, result.scalar_one())

    async def earn(
        self,
        user_id: uuid.UUID,
        point_type: PointType,
        amount: int,
        tx_type: PointTransactionType,
        reference_id: uuid.UUID | None = None,
        description: str | None = None,
        idempotency_key: str | None = None,
    ) -> PointTransaction:
        """Credit points to a user's wallet."""
        if amount <= 0:
            raise ValueError("Earn amount must be positive")

        if idempotency_key:
            existing = (
                await self.session.execute(
                    select(PointTransaction).where(
                        PointTransaction.idempotency_key == idempotency_key
                    )
                )
            ).scalar_one_or_none()
            if existing:
                return existing  # 멱등 — 중복 적립 차단

        wallet = await self.get_wallet(user_id, point_type, for_update=True)
        if not wallet:
            raise ValueError(f"No {point_type.value} wallet for user {user_id}")

        wallet.balance += amount
        wallet.lifetime_earned += amount
        wallet.updated_at = datetime.now(timezone.utc)

        tx = PointTransaction(
            wallet_id=wallet.id,
            user_id=user_id,
            tx_type=tx_type,
            amount=amount,
            balance_after=wallet.balance,
            reference_id=reference_id,
            description=description,
            idempotency_key=idempotency_key,
        )
        self.session.add(tx)
        await self.session.flush()
        return tx

    async def deduct(
        self,
        user_id: uuid.UUID,
        point_type: PointType,
        amount: int,
        tx_type: PointTransactionType,
        reference_id: uuid.UUID | None = None,
        description: str | None = None,
        allow_overdraft: bool = False,
        idempotency_key: str | None = None,
    ) -> PointTransaction:
        """Deduct points from a user's wallet.

        The wallet row is locked (``for_update``) before reading the balance, so
        this method is the single serialization point for spends — callers must
        NOT pre-check the balance outside a lock and rely on it (TOCTOU race).

        ``allow_overdraft`` controls over-spend handling:
        - ``False`` (default, for spends): reject when ``amount > balance`` so the
          caller cannot under-charge a paid action. No transaction is recorded.
        - ``True`` (for penalties, e.g. no-show): floor the balance at 0 and
          record the *actual* amount removed, not the requested amount.

        The recorded transaction ``amount`` always equals the balance delta, so
        the ledger reconciles with ``balance_after``.
        """
        if amount <= 0:
            raise ValueError("Deduct amount must be positive")

        if idempotency_key:
            existing = (
                await self.session.execute(
                    select(PointTransaction).where(
                        PointTransaction.idempotency_key == idempotency_key
                    )
                )
            ).scalar_one_or_none()
            if existing:
                return existing  # 멱등 — 중복 차감 차단

        wallet = await self.get_wallet(user_id, point_type, for_update=True)
        if not wallet:
            raise ValueError(f"No {point_type.value} wallet for user {user_id}")

        if amount > wallet.balance and not allow_overdraft:
            raise ValueError(
                f"Insufficient balance: have {wallet.balance}, need {amount}"
            )

        actual_deduction = min(wallet.balance, amount)
        wallet.balance = max(0, wallet.balance - amount)
        wallet.lifetime_spent += actual_deduction
        wallet.updated_at = datetime.now(timezone.utc)

        tx = PointTransaction(
            wallet_id=wallet.id,
            user_id=user_id,
            tx_type=tx_type,
            amount=-actual_deduction,
            balance_after=wallet.balance,
            reference_id=reference_id,
            description=description,
            idempotency_key=idempotency_key,
        )
        self.session.add(tx)
        await self.session.flush()
        return tx

    async def deduct_both(
        self,
        user_id: uuid.UUID,
        amount: int,
        tx_type: PointTransactionType,
        reference_id: uuid.UUID | None = None,
        description: str | None = None,
    ) -> list[PointTransaction]:
        """Deduct from both Fan and Social wallets simultaneously."""
        txs = []
        for pt in [PointType.FAN, PointType.SOCIAL]:
            tx = await self.deduct(user_id, pt, amount, tx_type, reference_id, description)
            txs.append(tx)
        return txs

    async def get_history(
        self,
        user_id: uuid.UUID,
        point_type: PointType | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> list[PointTransaction]:
        query = select(PointTransaction).where(PointTransaction.user_id == user_id)

        if point_type:
            wallet = await self.get_wallet(user_id, point_type)
            if not wallet:
                return []
            query = query.where(PointTransaction.wallet_id == wallet.id)

        query = query.order_by(PointTransaction.created_at.desc()).limit(limit).offset(offset)
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def get_decayed_balance(
        self,
        db: AsyncSession,
        user_id: uuid.UUID,
        point_type: PointType,
        reference_date: datetime | None = None,
    ) -> float:
        """Compute effective balance with exponential time decay.

        Applies exponential decay to point transactions based on age,
        with a 365-day half-life. Points earned 1 year ago are worth 50%
        of their original value, 2 years ago 25%, etc.

        This creates a 'use-it-or-lose-it' dynamic that incentivizes
        active participation and prevents point hoarding.

        Args:
            db: Database session.
            user_id: Target user.
            point_type: FAN or SOCIAL.
            reference_date: Date to compute decay from (default: now).

        Returns:
            Decayed effective balance (float).
        """
        import math

        ref = reference_date or datetime.now(timezone.utc)
        half_life_days = 365.0
        decay_lambda = math.log(2) / half_life_days

        # Resolve wallet to get wallet_id for transaction lookup
        wallet = await self.get_wallet(user_id, point_type)
        if not wallet:
            return 0.0

        # Fetch all transactions for this wallet
        result = await db.execute(
            select(PointTransaction)
            .where(
                PointTransaction.wallet_id == wallet.id,
            )
            .order_by(PointTransaction.created_at.asc())
        )
        transactions = result.scalars().all()

        effective_balance = 0.0
        for tx in transactions:
            age_days = (ref - tx.created_at.replace(tzinfo=timezone.utc)).total_seconds() / 86400.0
            decay_factor = math.exp(-decay_lambda * max(0, age_days))
            effective_balance += tx.amount * decay_factor

        return max(0.0, effective_balance)

    async def earn_domain_special(
        self,
        user_id: uuid.UUID,
        domain: str,
        action: str,
        reference_id: uuid.UUID | None = None,
    ) -> PointTransaction | None:
        """Award domain-specific special AP.

        Looks up the AP amount from DOMAIN_SPECIAL_AP for the given
        domain + action combination. If found, credits the user's
        appropriate wallet (Social for sports/civic, Fan for others).

        Args:
            user_id: User's UUID.
            domain: Domain name (e.g. "sports", "musical", "exhibition").
            action: Domain-specific action (e.g. "season_ticket", "rewatch").
            reference_id: Optional reference UUID (event_id, team_id, etc.).

        Returns:
            PointTransaction if AP was awarded, None if domain/action not found.
        """
        domain_actions = DOMAIN_SPECIAL_AP.get(domain, {})
        ap = domain_actions.get(action)
        if not ap:
            return None

        # Sports and civic use Social Points; others use Fan Points
        social_domains = {"sports", "civic"}
        point_type = PointType.SOCIAL if domain in social_domains else PointType.FAN

        tx = await self.earn(
            user_id=user_id,
            point_type=point_type,
            amount=ap,
            tx_type=PointTransactionType.EARN_DOMAIN_SPECIAL,
            reference_id=reference_id,
            description=f"도메인 특화 보너스: {domain}/{action}",
        )
        return tx

    async def get_lottery_weights_batch(
        self,
        user_ids: list[uuid.UUID],
        event_category: str,
        weight_method: str = "sqrt",
    ) -> dict[uuid.UUID, float]:
        """Batch version of get_lottery_weight() — single query for all users.

        Eliminates N+1 queries by fetching activity-only balances for all
        users in one SQL statement, then applying the weight formula.

        Args:
            user_ids: List of user UUIDs to compute weights for.
            event_category: Event category (sports/public → SOCIAL, else FAN).
            weight_method: Weight function: 'sqrt', 'log', or 'linear'.

        Returns:
            Mapping of user_id → lottery weight (floor = 1.0).
        """
        import math

        W_FLOOR = 1.0

        if not user_ids:
            return {}

        social_categories = {"sports", "public"}
        point_type = (
            PointType.SOCIAL if event_category.lower() in social_categories else PointType.FAN
        )

        # Single query: join wallets + transactions, exclude purchase-based types,
        # group by user_id to get activity-only balance per user.
        result = await self.session.execute(
            select(
                PointWallet.user_id,
                func.coalesce(func.sum(PointTransaction.amount), 0).label("activity_balance"),
            )
            .select_from(PointWallet)
            .outerjoin(
                PointTransaction,
                (PointTransaction.wallet_id == PointWallet.id)
                & (PointTransaction.tx_type.not_in([t.value for t in PURCHASE_BASED_TYPES])),
            )
            .where(
                PointWallet.point_type == point_type,
                PointWallet.user_id.in_(user_ids),
            )
            .group_by(PointWallet.user_id)
        )
        rows = result.all()

        # Build balance map; users without wallets or transactions get 0
        balance_map: dict[uuid.UUID, int] = {row.user_id: max(0, row.activity_balance) for row in rows}

        # Apply weight formula
        weights: dict[uuid.UUID, float] = {}
        for uid in user_ids:
            balance = balance_map.get(uid, 0)
            if weight_method == "sqrt":
                weights[uid] = max(W_FLOOR, math.sqrt(balance))
            elif weight_method == "log":
                weights[uid] = max(W_FLOOR, 1.0 + math.log(1.0 + balance))
            else:  # linear
                weights[uid] = max(W_FLOOR, float(balance))

        return weights

    async def get_lottery_weight(
        self,
        user_id: uuid.UUID,
        event_category: str,
        weight_method: str = "sqrt",
    ) -> float:
        """Category-based lottery weight with nonlinear transformation.

        Supports multiple weight functions to prevent high-point users
        from having disproportionate advantage:

        - 'linear': max(W_floor, balance)  [original]
        - 'sqrt': max(W_floor, sqrt(balance))  [moderate compression]
        - 'log': max(W_floor, 1 + ln(1 + balance))  [strong compression]

        W_floor = 1.0 guarantees minimum participation for zero-balance users.

        Sports and public categories use Social Points; everything else uses Fan Points.

        WP07: 구매 기반 AP(EARN_PURCHASE, EARN_GOODS)는 추첨 가중치 산출에서
        제외됩니다. get_activity_only_balance()를 사용하여 순수 활동 기반 잔액만
        가중치 계산에 반영합니다.
        """
        import math

        social_categories = {"sports", "public"}
        point_type = (
            PointType.SOCIAL if event_category.lower() in social_categories else PointType.FAN
        )
        # WP07: 구매 기반 AP 제외한 활동 전용 잔액 사용
        balance = await self.get_activity_only_balance(user_id, point_type)

        W_FLOOR = 1.0

        if weight_method == "sqrt":
            return max(W_FLOOR, math.sqrt(balance))
        elif weight_method == "log":
            return max(W_FLOOR, 1.0 + math.log(1.0 + balance))
        else:  # linear (original behavior)
            return max(W_FLOOR, float(balance))
