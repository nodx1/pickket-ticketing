import json
import asyncio
import aiosqlite
from datetime import datetime, timedelta
from .base import StorageBackend


class SQLiteStorage(StorageBackend):
    """SQLite 기반 저장소. 팀 1-3명 로컬/소규모 환경에 적합."""

    def __init__(self, db_path: str = ".mcp-dev.db"):
        self.db_path = db_path
        self._db: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")  # 동시 읽기/쓰기 안전
        await self._db.execute("PRAGMA foreign_keys=ON")
        await self._init_schema()

    async def disconnect(self) -> None:
        if self._db:
            await self._db.close()

    async def _init_schema(self) -> None:
        await self._db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                expires_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS file_locks (
                file_path TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                developer TEXT NOT NULL,
                branch TEXT NOT NULL DEFAULT '',
                locked_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS handoffs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS blockers (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                resolved INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS event_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS tokens (
                token_hash TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        """)
        await self._db.commit()

    async def _now(self) -> str:
        return datetime.utcnow().isoformat()

    # ── Task ──────────────────────────────────────────────────────────────────

    async def create_task(self, task_id: str, data: dict, ttl_seconds: int) -> None:
        expires_at = (datetime.utcnow() + timedelta(seconds=ttl_seconds)).isoformat()
        async with self._lock:
            await self._db.execute(
                "INSERT OR REPLACE INTO tasks (id, data, expires_at) VALUES (?, ?, ?)",
                (task_id, json.dumps(data), expires_at)
            )
            await self._db.commit()

    async def get_task(self, task_id: str) -> dict | None:
        async with self._db.execute(
            "SELECT data FROM tasks WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)",
            (task_id, datetime.utcnow().isoformat())
        ) as cur:
            row = await cur.fetchone()
            return json.loads(row["data"]) if row else None

    async def update_task(self, task_id: str, data: dict) -> None:
        async with self._lock:
            await self._db.execute(
                "UPDATE tasks SET data = ? WHERE id = ?",
                (json.dumps(data), task_id)
            )
            await self._db.commit()

    async def delete_task(self, task_id: str) -> None:
        async with self._lock:
            await self._db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            await self._db.commit()

    async def get_active_tasks(self) -> list[dict]:
        async with self._db.execute(
            "SELECT data FROM tasks WHERE (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC",
            (datetime.utcnow().isoformat(),)
        ) as cur:
            rows = await cur.fetchall()
            tasks = [json.loads(r["data"]) for r in rows]
            return [t for t in tasks if t.get("status") not in ("completed", "cancelled")]

    # ── File Lock ─────────────────────────────────────────────────────────────

    async def set_lock(self, file_path: str, task_id: str, developer: str,
                       branch: str, ttl_seconds: int) -> None:
        expires_at = (datetime.utcnow() + timedelta(seconds=ttl_seconds)).isoformat()
        async with self._lock:
            await self._db.execute(
                "INSERT OR REPLACE INTO file_locks (file_path, task_id, developer, branch, locked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                (file_path, task_id, developer, branch, await self._now(), expires_at)
            )
            await self._db.commit()

    async def get_lock(self, file_path: str) -> dict | None:
        async with self._db.execute(
            "SELECT * FROM file_locks WHERE file_path = ? AND expires_at > ?",
            (file_path, datetime.utcnow().isoformat())
        ) as cur:
            row = await cur.fetchone()
            if not row:
                return None
            return dict(row)

    async def release_lock(self, file_path: str) -> bool:
        async with self._lock:
            cur = await self._db.execute("DELETE FROM file_locks WHERE file_path = ?", (file_path,))
            await self._db.commit()
            return cur.rowcount > 0

    async def get_all_locks(self) -> dict[str, dict]:
        async with self._db.execute(
            "SELECT * FROM file_locks WHERE expires_at > ?",
            (datetime.utcnow().isoformat(),)
        ) as cur:
            rows = await cur.fetchall()
            return {r["file_path"]: dict(r) for r in rows}

    # ── Handoff ───────────────────────────────────────────────────────────────

    async def push_handoff(self, data: dict) -> None:
        async with self._lock:
            await self._db.execute("INSERT INTO handoffs (data) VALUES (?)", (json.dumps(data),))
            # 최근 50개만 유지
            await self._db.execute(
                "DELETE FROM handoffs WHERE id NOT IN (SELECT id FROM handoffs ORDER BY id DESC LIMIT 50)"
            )
            await self._db.commit()

    async def get_handoffs(self, limit: int = 20) -> list[dict]:
        async with self._db.execute(
            "SELECT data, created_at FROM handoffs ORDER BY id DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
            result = []
            for r in rows:
                d = json.loads(r["data"])
                d["created_at"] = r["created_at"]
                result.append(d)
            return result

    # ── Blocker ───────────────────────────────────────────────────────────────

    async def push_blocker(self, data: dict) -> None:
        async with self._lock:
            await self._db.execute(
                "INSERT INTO blockers (id, data) VALUES (?, ?)",
                (data["id"], json.dumps(data))
            )
            await self._db.commit()

    async def get_blockers(self, limit: int = 10) -> list[dict]:
        async with self._db.execute(
            "SELECT data FROM blockers WHERE resolved = 0 ORDER BY rowid DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
            return [json.loads(r["data"]) for r in rows]

    async def resolve_blocker(self, blocker_id: str) -> bool:
        async with self._lock:
            cur = await self._db.execute(
                "UPDATE blockers SET resolved = 1 WHERE id = ?", (blocker_id,)
            )
            await self._db.commit()
            return cur.rowcount > 0

    # ── Event Log ─────────────────────────────────────────────────────────────

    async def log_event(self, event_type: str, data: dict) -> None:
        async with self._lock:
            await self._db.execute(
                "INSERT INTO event_log (event_type, data) VALUES (?, ?)",
                (event_type, json.dumps(data))
            )
            await self._db.commit()

    async def get_events(self, hours: int = 24) -> list[dict]:
        since = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
        async with self._db.execute(
            "SELECT event_type, data, created_at FROM event_log WHERE created_at > ? ORDER BY id DESC",
            (since,)
        ) as cur:
            rows = await cur.fetchall()
            result = []
            for r in rows:
                d = json.loads(r["data"])
                d["event_type"] = r["event_type"]
                d["created_at"] = r["created_at"]
                result.append(d)
            return result

    # ── Token ─────────────────────────────────────────────────────────────────

    async def set_token(self, token_hash: str, data: dict) -> None:
        async with self._lock:
            await self._db.execute(
                "INSERT OR REPLACE INTO tokens (token_hash, data) VALUES (?, ?)",
                (token_hash, json.dumps(data))
            )
            await self._db.commit()

    async def get_token(self, token_hash: str) -> dict | None:
        async with self._db.execute(
            "SELECT data FROM tokens WHERE token_hash = ?", (token_hash,)
        ) as cur:
            row = await cur.fetchone()
            return json.loads(row["data"]) if row else None

    async def delete_token(self, token_hash: str) -> bool:
        async with self._lock:
            cur = await self._db.execute("DELETE FROM tokens WHERE token_hash = ?", (token_hash,))
            await self._db.commit()
            return cur.rowcount > 0

    async def list_tokens(self) -> list[dict]:
        async with self._db.execute(
            "SELECT data, created_at FROM tokens ORDER BY created_at DESC"
        ) as cur:
            rows = await cur.fetchall()
            result = []
            for r in rows:
                d = json.loads(r["data"])
                d["created_at"] = r["created_at"]
                result.append(d)
            return result

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
