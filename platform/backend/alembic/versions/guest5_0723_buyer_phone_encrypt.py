"""상세통합 정합보강 — orders.buyer_phone PII 암호화(컬럼 폭 확장)

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §6.3(PII).

배경(막내 검수 정합 갭 #2):
    `guests.phone_enc` 는 EncryptedString(암호화)인데 게스트 체크아웃 스냅샷인
    `orders.buyer_phone` 는 평문(String(50))이라 PII 노출(PIPA) — 동일 전화번호가
    한쪽은 암호화, 한쪽은 평문. 게스트 주문(internal_commerce)이 buyer_phone 을
    평문 저장 → orders.buyer_phone 도 EncryptedString 로 전환한다.

암호화 방식(§6.3):
    - EncryptedString 은 앱계층 TypeDecorator(Fernet) — **DB 컬럼 타입은 문자열 그대로**.
      모델만 EncryptedString(length=512)로 바꾸면 이후 쓰기가 `enc::` 프리픽스로 암호화됨.
    - ⚠️ 단, Fernet ciphertext 는 105자(전화번호 기준) > 기존 String(50) → **컬럼 폭 확장 필요**.
      이 마이그가 buyer_phone 을 String(50) → String(512) 로 확장한다(모델 정합).
    - buyer_email 은 **암호화하지 않음**: internal_commerce_read 의 주문/참석자 검색이
      buyer_email.ilike(%q%) 로 SQL 필터링(조회키) → 비결정적 Fernet ciphertext 는
      패턴매칭 불가라 검색이 깨진다. buyer_email 은 평문 유지 + API 계층 마스킹(_mask_email).

기존 평문 데이터 처리(초기화 전제):
    dev_v3 는 재초기화 전제(squash §6.4)라 기존 buyer_phone 평문 행이 없다. 만약
    운영 백필이 필요하면 EncryptedString.process_result_value 가 `enc::` 프리픽스 없는
    값을 평문 그대로 반환(decrypt_pii_text 폴백)하므로 **읽기는 안전**하고, 다음 쓰기 시
    자동 암호화된다(점진 마이그레이션). 이 마이그는 컬럼 폭만 확장(데이터 무변).

⚠️ dev DB 적용은 오케스트레이터 승인 게이트 후. dev_v3 정본 squash 시 흡수(§6.4).

Revision ID: guest5_0723
Revises: guest4_0723
"""

import sqlalchemy as sa
from alembic import op

revision = "guest5_0723"
down_revision = "guest4_0723"
branch_labels = None
depends_on = None


def _has_table(insp, name: str) -> bool:
    return insp.has_table(name)


def _col(insp, table: str, name: str):
    for c in insp.get_columns(table):
        if c["name"] == name:
            return c
    return None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if _has_table(insp, "orders"):
        col = _col(insp, "orders", "buyer_phone")
        # 이미 512(재실행) 이면 스킵. sqlite 는 length 미보고(None) → postgres 만 확장 대상.
        length = getattr(col["type"], "length", None) if col else None
        if col is not None and (length is None or length < 512):
            op.alter_column(
                "orders",
                "buyer_phone",
                existing_type=sa.String(length=50),
                type_=sa.String(length=512),
                existing_nullable=True,
            )


def downgrade() -> None:
    # 축소(512→50)는 암호화 ciphertext(105자) truncation 위험 → 비파괴 원칙상 no-op.
    # (초기화·squash 전략상 down-migration 은 불요.)
    pass
