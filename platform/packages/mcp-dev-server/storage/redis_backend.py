import json
import os
from datetime import datetime, timedelta
from .base import StorageBackend

try:
    import redis.asyncio as aioredis
except ImportError:
    aioredis = None  # type: ignore


class RedisStorage(StorageBackend):
    """Redis 기반 저장소. 프로덕션 분산 환경용 (TLS 지원)."""

    def __init__(self, redis_url: str | None = None, db: int = 2):
        self.redis_url = redis_url or os.environ.get("REDIS_URL", "redis://localhost:6379")
        self.db = db
        self._client = None

    async def connect(self) -> None:
        if aioredis is None:
            raise ImportError("redis 패키지가 없습니다: pip install redis")
        # redis://... 또는 rediss://... (TLS)
        url = self.redis_url
        # DB 번호 삽입 (URL에 없으면 추가)
        if not url.endswith(f"/{self.db}") and "/?" not in url:
            # URL 마지막에 /2 형태로 DB 지정
            base = url.rstrip("/")
            # 이미 /0 /1 등 있으면 교체
            import re
            base = re.sub(r"/\d+$", "", base)
            url = f"{base}/{self.db}"

        ssl = url.startswith("rediss://")
        self._client = aioredis.from_url(
            url,
            decode_responses=True,
            ssl_cert_reqs=None if ssl else None,
        )
        await self._client.ping()

    async def disconnect(self) -> None:
        if self._client:
            await self._client.aclose()

    def _task_key(self, task_id: str) -> str:
        return f"mcp:task:{task_id}"

    def _lock_key(self, file_path: str) -> str:
        return f"mcp:lock:{file_path}"

    # ── Task ──────────────────────────────────────────────────────────────────

    async def create_task(self, task_id: str, data: dict, ttl_seconds: int) -> None:
        key = self._task_key(task_id)
        await self._client.set(key, json.dumps(data), ex=ttl_seconds)
        await self._client.sadd("mcp:tasks:active", task_id)
        await self._client.expire("mcp:tasks:active", ttl_seconds * 2)

    async def get_task(self, task_id: str) -> dict | None:
        raw = await self._client.get(self._task_key(task_id))
        return json.loads(raw) if raw else None

    async def update_task(self, task_id: str, data: dict) -> None:
        key = self._task_key(task_id)
        ttl = await self._client.ttl(key)
        ex = ttl if ttl > 0 else 86400
        await self._client.set(key, json.dumps(data), ex=ex)

    async def delete_task(self, task_id: str) -> None:
        await self._client.delete(self._task_key(task_id))
        await self._client.srem("mcp:tasks:active", task_id)

    async def get_active_tasks(self) -> list[dict]:
        task_ids = await self._client.smembers("mcp:tasks:active")
        tasks = []
        for tid in task_ids:
            t = await self.get_task(tid)
            if t and t.get("status") not in ("completed", "cancelled"):
                tasks.append(t)
            elif not t:
                await self._client.srem("mcp:tasks:active", tid)
        return sorted(tasks, key=lambda x: x.get("started_at", ""), reverse=True)

    # ── File Lock ─────────────────────────────────────────────────────────────

    async def set_lock(self, file_path: str, task_id: str, developer: str,
                       branch: str, ttl_seconds: int) -> None:
        data = {
            "file_path": file_path,
            "task_id": task_id,
            "developer": developer,
            "branch": branch,
            "locked_at": datetime.utcnow().isoformat(),
        }
        await self._client.set(self._lock_key(file_path), json.dumps(data), ex=ttl_seconds)
        await self._client.hset("mcp:locks:index", file_path, task_id)
        await self._client.expire("mcp:locks:index", ttl_seconds * 2)

    async def get_lock(self, file_path: str) -> dict | None:
        raw = await self._client.get(self._lock_key(file_path))
        return json.loads(raw) if raw else None

    async def release_lock(self, file_path: str) -> bool:
        deleted = await self._client.delete(self._lock_key(file_path))
        await self._client.hdel("mcp:locks:index", file_path)
        return deleted > 0

    async def get_all_locks(self) -> dict[str, dict]:
        file_paths = await self._client.hkeys("mcp:locks:index")
        result = {}
        for fp in file_paths:
            lock = await self.get_lock(fp)
            if lock:
                result[fp] = lock
            else:
                await self._client.hdel("mcp:locks:index", fp)
        return result

    # ── Handoff ───────────────────────────────────────────────────────────────

    async def push_handoff(self, data: dict) -> None:
        await self._client.lpush("mcp:handoffs", json.dumps(data))
        await self._client.ltrim("mcp:handoffs", 0, 49)  # 최근 50개
        await self._client.expire("mcp:handoffs", 7 * 86400)  # 7일 보관

    async def get_handoffs(self, limit: int = 20) -> list[dict]:
        items = await self._client.lrange("mcp:handoffs", 0, limit - 1)
        return [json.loads(i) for i in items]

    # ── Blocker ───────────────────────────────────────────────────────────────

    async def push_blocker(self, data: dict) -> None:
        await self._client.lpush("mcp:blockers", json.dumps(data))
        await self._client.ltrim("mcp:blockers", 0, 19)
        await self._client.expire("mcp:blockers", 3 * 86400)

    async def get_blockers(self, limit: int = 10) -> list[dict]:
        items = await self._client.lrange("mcp:blockers", 0, limit - 1)
        blockers = [json.loads(i) for i in items]
        return [b for b in blockers if not b.get("resolved")]

    async def resolve_blocker(self, blocker_id: str) -> bool:
        items = await self._client.lrange("mcp:blockers", 0, -1)
        for i, raw in enumerate(items):
            b = json.loads(raw)
            if b.get("id") == blocker_id:
                b["resolved"] = True
                await self._client.lset("mcp:blockers", i, json.dumps(b))
                return True
        return False

    # ── Event Log ─────────────────────────────────────────────────────────────

    async def log_event(self, event_type: str, data: dict) -> None:
        entry = {"event_type": event_type, "created_at": datetime.utcnow().isoformat(), **data}
        await self._client.lpush("mcp:events", json.dumps(entry))
        await self._client.ltrim("mcp:events", 0, 999)
        await self._client.expire("mcp:events", 48 * 3600)

    async def get_events(self, hours: int = 24) -> list[dict]:
        since = datetime.utcnow() - timedelta(hours=hours)
        items = await self._client.lrange("mcp:events", 0, -1)
        result = []
        for raw in items:
            e = json.loads(raw)
            try:
                ts = datetime.fromisoformat(e.get("created_at", ""))
                if ts > since:
                    result.append(e)
            except (ValueError, TypeError):
                result.append(e)
        return result

    # ── Token ─────────────────────────────────────────────────────────────────

    async def set_token(self, token_hash: str, data: dict) -> None:
        await self._client.hset("mcp:tokens", token_hash, json.dumps(data))

    async def get_token(self, token_hash: str) -> dict | None:
        raw = await self._client.hget("mcp:tokens", token_hash)
        return json.loads(raw) if raw else None

    async def delete_token(self, token_hash: str) -> bool:
        deleted = await self._client.hdel("mcp:tokens", token_hash)
        return deleted > 0

    async def list_tokens(self) -> list[dict]:
        all_data = await self._client.hgetall("mcp:tokens")
        return [json.loads(v) for v in all_data.values()]

    # ── Branch/PR ─────────────────────────────────────────────────────────────

    async def find_task_by_branch(self, branch: str) -> dict | None:
        tasks = await self.get_active_tasks()
        for t in tasks:
            if t.get("branch") == branch:
                return t
        return None

    async def link_pr(self, task_id: str, pr_url: str) -> None:
        task = await self.get_task(task_id)
        if task:
            task["pr_url"] = pr_url
            await self.update_task(task_id, task)
