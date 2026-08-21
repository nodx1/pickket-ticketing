"""공통 서비스 베이스.

모든 도메인 서비스(`domains/<x>/service.py`)는 이 BaseService 를 상속한다.
트랜잭션 경계 관리와 go/mobile 전파(propagations) 패턴을 표준화한다.

사용 예:
    class PaymentService(BaseService):
        def __init__(self, session: AsyncSession):
            super().__init__(session)
            self.order_repo = OrderRepository(session)

        async def confirm(self, order_id: UUID) -> Order:
            order = await self.order_repo.get_for_update(order_id)
            # ... 비즈니스 로직 ...
            self.propagate("order.confirmed", {"order_id": str(order.id)})
            return order

호출 측(라우터·다른 서비스)은:
    service = PaymentService(db)
    result = await service.confirm(order_id)
    await db.commit()
    await drain_propagations(service.propagations)  # Celery 큐잉

금지:
    - FastAPI Depends/HTTPException 사용 (도메인 예외만 raise)
    - HTTP 응답 객체 직접 구성 (라우터에서 변환)
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession


class BaseService:
    """비즈니스 로직 계층 베이스.

    트랜잭션 commit/rollback 은 호출자(라우터 의존성 또는 상위 서비스)가 담당한다.
    서비스 내부에서는 repository 호출 + propagations 누적만 수행한다.
    이렇게 분리하는 이유:
        1. 한 요청 안에서 여러 서비스 호출을 단일 트랜잭션으로 묶기 위함
        2. commit 후에만 외부 시스템(go/Celery/SNS)에 전파해야 데이터 정합성 유지
    """

    def __init__(self, session: AsyncSession):
        self.session = session
        # commit 성공 후 호출자가 Celery/EventBus 로 흘려보낼 이벤트들.
        # 각 dict 는 최소 {"topic": str, "payload": dict} 형태를 갖는다.
        self.propagations: list[dict[str, Any]] = []

    def propagate(self, topic: str, payload: dict[str, Any]) -> None:
        """commit 후 외부에 전파할 이벤트 누적.

        Args:
            topic: 이벤트 토픽 — "order.confirmed", "payment.completed" 등
            payload: 직렬화 가능한 dict (UUID 는 str 로 변환)
        """
        self.propagations.append({"topic": topic, "payload": payload})


async def drain_propagations(propagations: list[dict[str, Any]]) -> None:
    """누적된 propagations 를 Celery/EventBus 로 흘려보낸다.

    DB commit 성공 직후에만 호출해야 한다 (rollback 시 외부 전파 금지).
    실제 디스패치는 각 도메인의 task 또는 event_bus 모듈이 담당하며,
    이 함수는 일관된 호출 지점만 제공한다.

    Args:
        propagations: BaseService.propagate() 로 누적된 이벤트 목록.
    """
    if not propagations:
        return
    # 구현 위치: app/core/event_bus.py 의 dispatch() 사용 (Phase 4 에서 wiring).
    # Phase 0 단계에서는 인터페이스만 노출. import 순환 회피 위해 lazy import.
    from app.core.event_bus import dispatch_propagations  # noqa: WPS433

    await dispatch_propagations(propagations)
