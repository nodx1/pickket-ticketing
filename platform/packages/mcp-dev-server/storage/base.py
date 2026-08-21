from abc import ABC, abstractmethod
from typing import Any


class StorageBackend(ABC):
    """추상 저장소 인터페이스. SQLite와 Redis 모두 이 인터페이스를 구현."""

    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    # ── Task ──────────────────────────────────────────────────────────────────

    @abstractmethod
    async def create_task(self, task_id: str, data: dict, ttl_seconds: int) -> None: ...

    @abstractmethod
    async def get_task(self, task_id: str) -> dict | None: ...

    @abstractmethod
    async def update_task(self, task_id: str, data: dict) -> None: ...

    @abstractmethod
    async def delete_task(self, task_id: str) -> None: ...

    @abstractmethod
    async def get_active_tasks(self) -> list[dict]: ...

    # ── File Lock ─────────────────────────────────────────────────────────────

    @abstractmethod
    async def set_lock(self, file_path: str, task_id: str, developer: str,
                       branch: str, ttl_seconds: int) -> None: ...

    @abstractmethod
    async def get_lock(self, file_path: str) -> dict | None: ...

    @abstractmethod
    async def release_lock(self, file_path: str) -> bool: ...

    @abstractmethod
    async def get_all_locks(self) -> dict[str, dict]: ...

    # ── Handoff ───────────────────────────────────────────────────────────────

    @abstractmethod
    async def push_handoff(self, data: dict) -> None: ...

    @abstractmethod
    async def get_handoffs(self, limit: int = 20) -> list[dict]: ...

    # ── Blocker ───────────────────────────────────────────────────────────────

    @abstractmethod
    async def push_blocker(self, data: dict) -> None: ...

    @abstractmethod
    async def get_blockers(self, limit: int = 10) -> list[dict]: ...

    @abstractmethod
    async def resolve_blocker(self, blocker_id: str) -> bool: ...

    # ── Event Log (Timeline) ──────────────────────────────────────────────────

    @abstractmethod
    async def log_event(self, event_type: str, data: dict) -> None: ...

    @abstractmethod
    async def get_events(self, hours: int = 24) -> list[dict]: ...

    # ── Token ─────────────────────────────────────────────────────────────────

    @abstractmethod
    async def set_token(self, token_hash: str, data: dict) -> None: ...

    @abstractmethod
    async def get_token(self, token_hash: str) -> dict | None: ...

    @abstractmethod
    async def delete_token(self, token_hash: str) -> bool: ...

    @abstractmethod
    async def list_tokens(self) -> list[dict]: ...

    # ── Branch/PR Link ────────────────────────────────────────────────────────

    @abstractmethod
    async def find_task_by_branch(self, branch: str) -> dict | None: ...

    @abstractmethod
    async def link_pr(self, task_id: str, pr_url: str) -> None: ...
