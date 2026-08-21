"""Custom SQLAlchemy column types for Pickket models."""

from decimal import Decimal

from sqlalchemy import Numeric, TypeDecorator


class Money(TypeDecorator):
    """Numeric(12, 2) stored in the database, returned as Python Decimal.

    Policy (AUDIT 2026-05-28 §33 P0 fix):
    - DB에는 NUMERIC(12,2) 그대로 저장 (정밀도 유지).
    - Python 레이어에 Decimal 반환 — IEEE 754 정밀도 손실 방지.
    - process_bind_param: Decimal/float/int → str → Decimal 변환 후 DB 저장.
    - process_result_value: DB 값 → Decimal(str(value)) 반환.

    이전 정책(float 반환)은 ADR-012에서 폐기됨.
    누적 산술 시 호출측에서 별도 승격이 필요 없어짐.
    """

    impl = Numeric(12, 2)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None:
            return Decimal(str(value))
        return value

    def process_result_value(self, value, dialect):
        if value is not None:
            return Decimal(str(value))
        return value
