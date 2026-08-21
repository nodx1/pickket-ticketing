"""공통 저장소 베이스.

모든 도메인 저장소(`domains/<x>/repository.py`)는 이 BaseRepository 를 상속한다.
SQLAlchemy 쿼리·저장 로직을 캡슐화하여 라우터·서비스가 ORM 을 직접 다루지 않도록 한다.

사용 예:
    class EventRepository(BaseRepository[Event]):
        def __init__(self, session: AsyncSession):
            super().__init__(Event, session)

        async def find_by_organizer(self, organizer_id: UUID) -> list[Event]:
            stmt = select(self.model).where(self.model.organizer_id == organizer_id)
            result = await self.session.execute(stmt)
            return list(result.scalars().all())

금지:
    - 비즈니스 규칙 (서비스 계층 책임)
    - 다른 도메인 모델 직접 참조 (해당 도메인 서비스 경유)
"""

from __future__ import annotations

import uuid
from typing import Any, Generic, Type, TypeVar

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import Base

ModelT = TypeVar("ModelT", bound=Base)


class BaseRepository(Generic[ModelT]):
    """공통 CRUD 패턴을 제공하는 저장소 베이스 클래스.

    상속 클래스는 도메인 특화 쿼리만 추가하면 된다.
    트랜잭션 commit/rollback 은 서비스 계층(BaseService)에서 수행한다.
    여기선 session.flush() 까지만 호출하여 ID/관계가 채워지도록 한다.
    """

    def __init__(self, model: Type[ModelT], session: AsyncSession):
        self.model = model
        self.session = session

    async def get(self, id: uuid.UUID) -> ModelT | None:
        """PK 로 단건 조회. 없으면 None."""
        result = await self.session.execute(select(self.model).where(self.model.id == id))
        return result.scalar_one_or_none()

    async def get_or_404(self, id: uuid.UUID, *, not_found_error: Exception | None = None) -> ModelT:
        """PK 로 단건 조회. 없으면 도메인 예외(또는 ValueError) raise.

        Args:
            id: 조회 대상 PK
            not_found_error: 도메인에서 정의한 예외 인스턴스. None 이면 ValueError.
        """
        obj = await self.get(id)
        if obj is None:
            raise not_found_error or ValueError(f"{self.model.__name__}(id={id}) not found")
        return obj

    async def get_for_update(self, id: uuid.UUID) -> ModelT | None:
        """SELECT ... FOR UPDATE — 행 잠금 후 조회 (결제·재고 같이 경합 발생 경로)."""
        result = await self.session.execute(
            select(self.model).where(self.model.id == id).with_for_update()
        )
        return result.scalar_one_or_none()

    async def list(self, *, skip: int = 0, limit: int = 100) -> list[ModelT]:
        """단순 페이지네이션 목록. 필터·정렬은 상속 클래스에서 추가 구현."""
        result = await self.session.execute(select(self.model).offset(skip).limit(limit))
        return list(result.scalars().all())

    async def paginate(
        self, *, skip: int = 0, limit: int = 100
    ) -> tuple[list[ModelT], int]:
        """목록 + 총 개수 함께 반환 — UI 페이지네이션 표시용."""
        items = await self.list(skip=skip, limit=limit)
        total = await self.count()
        return items, total

    async def create(self, **kwargs: Any) -> ModelT:
        """필드 값으로 새 행 생성. flush 까지 수행하여 PK/관계 채움."""
        obj = self.model(**kwargs)
        self.session.add(obj)
        await self.session.flush()
        return obj

    async def bulk_create(self, items: list[dict[str, Any]]) -> list[ModelT]:
        """다건 일괄 삽입. SQLAlchemy add_all + flush."""
        objs = [self.model(**item) for item in items]
        self.session.add_all(objs)
        await self.session.flush()
        return objs

    async def update(self, obj: ModelT, **kwargs: Any) -> ModelT:
        """주어진 객체의 필드를 갱신. flush 까지 수행."""
        for key, value in kwargs.items():
            setattr(obj, key, value)
        await self.session.flush()
        return obj

    async def count(self) -> int:
        """모델 전체 행 수. 필터된 카운트는 상속 클래스에서 별도 구현."""
        result = await self.session.execute(select(func.count(self.model.id)))
        return result.scalar() or 0

    async def delete(self, obj: ModelT) -> None:
        """행 삭제. flush 까지 수행."""
        await self.session.delete(obj)
        await self.session.flush()
