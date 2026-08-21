"""Saved card (billing key) management and one-click payment endpoints."""

import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.redis import get_redis, v2_key
from app.middleware.auth import get_current_user
from app.middleware.rate_limit import rate_limit_payment
from app.models.billing_key import BillingKey
from app.models.user import User
from app.schemas.billing import (
    BillingTokenRequest,
    CardResponse,
    CardListResponse,
    OneClickPayRequest,
    OneClickPayResponse,
)
from app.services.payment_service import PaymentService

logger = logging.getLogger(__name__)

router = APIRouter()

# 멱등 캐시 TTL — /purchase 라우터와 동일하게 결제 마감 윈도우에 고정
# (purchase.py `_idempotency_ttl_seconds` 패턴 재사용).
_IDEMPOTENCY_BUFFER_SECONDS = 60


def _idempotency_ttl_seconds() -> int:
    return settings.PAYMENT_EXPIRY_MINUTES * 60 + _IDEMPOTENCY_BUFFER_SECONDS


def _encrypt_billing_key(raw_key: str) -> str:
    """Encrypt a billing key at rest using Fernet.

    M-1: 키 미설정 시 조용한 평문 폴백 금지.
      - production/staging: 에러 — config 검증(BILLING_KEY_ENCRYPTION_KEY 필수)이
        기동을 거부하므로 정상 배포에서는 도달 불가하지만, 심층 방어로 한 번 더 차단.
        런타임에 시크릿 마운트 실패/핫리로드로 env var 가 비거나 settings 가 패치돼도
        실 빌링키를 평문 저장하지 않는다 (staging = production parity).
      - development/test: 경고 로그 후 평문 저장 (로컬/테스트 전용 명시적 동작).
    """
    if not settings.BILLING_KEY_ENCRYPTION_KEY:
        # 평문 카드 결제 토큰 저장은 실(實) 환경에서 어떤 경우에도 허용하지 않는다.
        if settings.ENVIRONMENT in ("production", "staging"):
            raise RuntimeError(
                "BILLING_KEY_ENCRYPTION_KEY is not configured — refusing to store "
                f"billing key in plaintext (env={settings.ENVIRONMENT})"
            )
        logger.warning(
            "BILLING_KEY_ENCRYPTION_KEY not set — storing billing key UNENCRYPTED. "
            "This is only acceptable in local/test environments (env=%s).",
            settings.ENVIRONMENT,
        )
        return raw_key
    from cryptography.fernet import Fernet

    fernet = Fernet(settings.BILLING_KEY_ENCRYPTION_KEY.encode())
    return fernet.encrypt(raw_key.encode()).decode()


# ── GET /api/v1/billing/cards ──────────────────────────────────────

@router.get(
    "/cards",
    response_model=CardListResponse,
    summary="저장된 카드 목록 조회",
    description="현재 사용자의 활성 저장 카드(빌링키) 목록을 마스킹된 형태로 반환합니다.",
)
async def list_cards(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(BillingKey)
        .where(BillingKey.user_id == user.id, BillingKey.deactivated_at.is_(None))
        .order_by(BillingKey.is_default.desc(), BillingKey.created_at.desc())
    )
    cards = list(result.scalars().all())
    return CardListResponse(
        cards=[CardResponse.model_validate(c) for c in cards],
        count=len(cards),
    )


# ── POST /api/v1/billing/cards ─────────────────────────────────────

@router.post(
    "/cards",
    response_model=CardResponse,
    status_code=status.HTTP_201_CREATED,
    summary="새 카드 등록 (프론트 SDK 토큰 수신)",
    description=(
        "PortOne Browser/RN SDK로 프론트에서 발급받은 billing_key 토큰을 수신하여 "
        "암호화 저장합니다. 서버는 PAN(card_number)/비밀번호/생년월일을 수신/저장하지 않습니다 "
        "(AUDIT §38 PCI-DSS)."
    ),
)
async def register_card(
    data: BillingTokenRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # AUDIT §38 P0: 클라이언트가 PortOne SDK로 직접 토큰화 → 서버는 저장만.
    # 과거에는 gateway.issue_billing_key(card_number, password_two_digits, ...)로
    # 서버가 PAN을 수신해 전달했지만, PCI-DSS scope를 최소화하기 위해 제거.

    # If set_default, unset previous default
    if data.set_default:
        prev_defaults = await db.execute(
            select(BillingKey).where(
                BillingKey.user_id == user.id,
                BillingKey.is_default.is_(True),
                BillingKey.deactivated_at.is_(None),
            )
        )
        for prev in prev_defaults.scalars().all():
            prev.is_default = False

    billing_key = BillingKey(
        user_id=user.id,
        billing_key=_encrypt_billing_key(data.billing_key),
        card_type=data.card_type,
        last_four=data.last_four,
        card_brand=data.card_brand,
        is_default=data.set_default,
        nickname=data.nickname,
    )
    db.add(billing_key)
    await db.commit()
    await db.refresh(billing_key)

    logger.info(
        "Billing key registered via client-side tokenization user=%s brand=%s last4=%s",
        user.id, data.card_brand, data.last_four,
    )
    return CardResponse.model_validate(billing_key)


# ── DELETE /api/v1/billing/cards/{id} ──────────────────────────────

@router.delete(
    "/cards/{card_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="저장된 카드 삭제",
    description="저장된 카드를 비활성화(논리삭제)합니다.",
)
async def remove_card(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(BillingKey).where(
            BillingKey.id == card_id,
            BillingKey.user_id == user.id,
            BillingKey.deactivated_at.is_(None),
        )
    )
    bk = result.scalar_one_or_none()
    if not bk:
        raise HTTPException(status_code=404, detail="저장된 카드를 찾을 수 없습니다")

    bk.deactivated_at = datetime.now(timezone.utc)
    bk.is_default = False
    await db.commit()


# ── PATCH /api/v1/billing/cards/{id}/default ───────────────────────

@router.patch(
    "/cards/{card_id}/default",
    response_model=CardResponse,
    summary="기본 결제 카드 설정",
    description="지정된 카드를 기본 결제 수단으로 설정합니다. 기존 기본 카드는 자동 해제됩니다.",
)
async def set_default_card(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Unset all previous defaults
    prev_result = await db.execute(
        select(BillingKey).where(
            BillingKey.user_id == user.id,
            BillingKey.is_default.is_(True),
            BillingKey.deactivated_at.is_(None),
        )
    )
    for prev in prev_result.scalars().all():
        prev.is_default = False

    # Set new default
    result = await db.execute(
        select(BillingKey).where(
            BillingKey.id == card_id,
            BillingKey.user_id == user.id,
            BillingKey.deactivated_at.is_(None),
        )
    )
    bk = result.scalar_one_or_none()
    if not bk:
        raise HTTPException(status_code=404, detail="저장된 카드를 찾을 수 없습니다")

    bk.is_default = True
    await db.commit()
    await db.refresh(bk)
    return CardResponse.model_validate(bk)


# ── POST /api/v1/billing/pay ───────────────────────────────────────

@router.post(
    "/pay",
    response_model=OneClickPayResponse,
    summary="원클릭 결제 (저장된 카드)",
    description="저장된 카드의 빌링키를 사용하여 주문을 즉시 결제합니다. billing_key_id를 지정하지 않으면 기본 카드로 결제됩니다.",
)
async def one_click_pay(
    data: OneClickPayRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    _rate_limit: None = Depends(rate_limit_payment),
):
    # 멱등 캐시 (M-2): 같은 idempotency_key 재요청은 이전 결과를 그대로 반환.
    # /purchase 라우터와 동일한 Redis 캐시 패턴 — 키 제공 시 Redis 불가면
    # fail-closed (재청구 위험이 서비스 거부보다 나쁨).
    idem_cache_key: str | None = None
    if data.idempotency_key:
        idem_cache_key = v2_key(f"idem:{user.id}:{data.idempotency_key}")
        try:
            redis = get_redis()
            cached = await redis.get(idem_cache_key)
            if cached:
                return JSONResponse(content=json.loads(cached))
        except Exception:
            logger.error("One-click idempotency check unavailable — blocking request", exc_info=True)
            raise HTTPException(
                status_code=503,
                detail="결제 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.",
            )

    # Resolve billing key id
    billing_key_id = data.billing_key_id
    if not billing_key_id:
        # Use default card
        default_result = await db.execute(
            select(BillingKey).where(
                BillingKey.user_id == user.id,
                BillingKey.is_default.is_(True),
                BillingKey.deactivated_at.is_(None),
            )
        )
        default_card = default_result.scalar_one_or_none()
        if not default_card:
            raise HTTPException(
                status_code=400,
                detail="기본 결제 카드가 설정되어 있지 않습니다. 카드를 등록해주세요.",
            )
        billing_key_id = default_card.id

    payment_svc = PaymentService(db)
    try:
        # NOTE: 서비스 내부가 2단계 트랜잭션 (① 청구 시도 기록 커밋 → ② PG 청구
        # → ③ 결과 반영)으로 동작한다. 아래 db.commit()은 ③(트랜잭션 2)을 커밋.
        order_resp = await payment_svc.process_one_click_payment(
            user_id=user.id,
            order_id=data.order_id,
            billing_key_id=billing_key_id,
            idempotency_key=data.idempotency_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("One-click payment failed: order=%s", data.order_id)
        raise HTTPException(
            status_code=502,
            detail="결제 처리에 실패했습니다",
        ) from exc

    await db.commit()

    # v2→go 전파 (DB commit 이후에 큐잉)
    from app.api.v1.orders import _drain_propagations
    _drain_propagations(payment_svc.propagations)

    # Fetch card info for response
    bk_result = await db.execute(
        select(BillingKey).where(BillingKey.id == billing_key_id)
    )
    bk = bk_result.scalar_one_or_none()

    response = OneClickPayResponse(
        order_id=order_resp.id,
        status=order_resp.status,
        payment_id=order_resp.payment_id or "",
        pg_transaction_id=order_resp.pg_transaction_id,
        amount=order_resp.total_amount,
        currency=order_resp.payment_currency,
        card_last_four=bk.last_four if bk else "****",
        card_brand=bk.card_brand if bk else "UNKNOWN",
    )

    # 멱등 캐시 기록 — 실패해도 치명적이지 않음 (DB 폴백: 같은 키 재요청 시
    # process_one_click_payment이 확정된 주문을 재청구 없이 반환).
    if idem_cache_key:
        try:
            redis = get_redis()
            await redis.setex(idem_cache_key, _idempotency_ttl_seconds(), response.model_dump_json())
        except Exception:
            logger.debug("Failed to write one-click idempotency cache", exc_info=True)

    return response
