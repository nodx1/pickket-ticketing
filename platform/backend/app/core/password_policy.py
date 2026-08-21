"""Password strength validation (공유 모듈).

가입, 비밀번호 리셋 등 모든 비밀번호 입력에서 동일 규칙 적용.
"""
import re


def validate_password_strength(password: str) -> str:
    """8~128 chars, 대문자 1+, 숫자 1+, 특수문자 1+ 필수."""
    if len(password) > 128:
        raise ValueError("비밀번호는 128자 이하여야 합니다.")
    if len(password) < 8:
        raise ValueError("비밀번호는 8자 이상이어야 합니다.")
    if not re.search(r"[A-Z]", password):
        raise ValueError("비밀번호에 대문자가 1자 이상 포함되어야 합니다.")
    if not re.search(r"\d", password):
        raise ValueError("비밀번호에 숫자가 1자 이상 포함되어야 합니다.")
    if not re.search(r"""[!@#$%^&*()\-_=+\[\]{}|;:'",.<>?/`~\\]""", password):
        raise ValueError("비밀번호에 특수문자가 1자 이상 포함되어야 합니다.")
    return password
