"""나이스 구형(allowpm1) + mainfix 두 head 통합 — **머지 리비전**

## 왜 필요했나 (2026-07-28 배포 실패)

배포한 backend 가 기동 시 `alembic upgrade head` 를 도는데 head 가 둘이라 실패했다:

    Multiple head revisions are present for given argument 'head'
    FATAL: Migration failed with exit code 255   → 크래시 루프 → 502 → 롤백

    allowpm1_0724 (head)   나이스 구형 브랜치 — events.allowed_pay_methods
    mainfix_0727  (head)   organizer_profiles 가산 컬럼(T1)

둘 다 `unify8_0723` 에서 갈라져 나와 다시 만난 적이 없다.

## 왜 재부모가 아니라 머지 리비전인가

나이스 실키 체크리스트에는 "재부모(allowpm1 → lvl2idem_0725)" 로 적혀 있었지만
**머지 리비전을 택했다.**

  · 재부모는 `allowpm1_0724.down_revision` 을 **덮어쓴다**. prod 는 아직 이 리비전을
    적용한 적이 없지만(실측: alembic_version = mainfix_0727 단일행, events 에
    allowed_pay_methods 컬럼 없음), **로컬 dev·테스트 DB 중에는 이미 적용한 곳이 있을 수
    있다**(나이스 구형 브랜치에서 샌드박스 실증을 했다). 그런 DB 는 자기가 서 있는 리비전의
    조상이 바뀌어 history/downgrade 가 어긋난다.
  · 머지 리비전은 기존 리비전 파일을 **하나도 건드리지 않는다.** 어느 DB 가 어디까지
    적용했든 안전하다. 이런 상황을 위해 alembic 이 제공하는 표준 수단이다.

## 적용 시 실제로 일어나는 일

이 리비전 자체는 **스키마를 바꾸지 않는다**(pass). 다만 prod 가 `mainfix_0727` 에 서 있으므로
`upgrade head` 는 아직 안 걸린 `allowpm1_0724` 를 **함께 적용**한다:

    ALTER TABLE events ADD COLUMN allowed_pay_methods JSONB NULL

가산·nullable·server_default 없음·백필 없음 → PG11+ 에서 **메타데이터 전용**(테이블 재작성
없음, 즉시 완료). 기존 행은 NULL = "전체 허용" 이라 **현행 동작이 바뀌지 않는다.**
(prod events 는 1행.) 해당 마이그는 컬럼 존재 가드가 있어 재실행도 안전하다.

Revision ID: nice_mrg_0728
Revises: allowpm1_0724, mainfix_0727
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'nice_mrg_0728'
down_revision: Union[str, Sequence[str], None] = ('allowpm1_0724', 'mainfix_0727')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """머지 전용 — 스키마 변경 없음(두 갈래를 하나의 head 로 합치기만 한다)."""


def downgrade() -> None:
    """머지 전용 — 되돌릴 스키마 변경이 없다."""
