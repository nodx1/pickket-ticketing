import secrets
import hashlib
from datetime import datetime


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class TokenManager:
    """팀원 토큰 발급/검증/폐기 관리."""

    def __init__(self, storage):
        self.storage = storage

    async def generate_token(self, developer: str) -> str:
        token = secrets.token_urlsafe(32)
        token_hash = _hash_token(token)
        await self.storage.set_token(token_hash, {
            "developer": developer,
            "created_at": datetime.utcnow().isoformat(),
            "token_prefix": token[:8] + "...",  # 표시용 (마스킹)
        })
        return token  # 원본 토큰은 한 번만 반환

    async def validate_token(self, token: str) -> str | None:
        """유효한 토큰이면 developer 이름 반환, 아니면 None."""
        token_hash = _hash_token(token)
        data = await self.storage.get_token(token_hash)
        if data:
            return data.get("developer")
        return None

    async def revoke_token(self, token: str) -> bool:
        token_hash = _hash_token(token)
        return await self.storage.delete_token(token_hash)

    async def list_tokens(self) -> list[dict]:
        """토큰 목록 (원본 노출 없이 prefix + developer만)."""
        return await self.storage.list_tokens()
