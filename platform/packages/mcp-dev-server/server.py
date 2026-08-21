"""
claude-team-sync MCP Dev Server
팀 Claude Code 세션 간 협업 조율 서버

MCP SSE + REST API + SSE 대시보드 통합
"""
import asyncio
import json
import uuid
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import AsyncIterator

from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp import types as mcp_types

from config import get_config
from path_utils import normalize_path
from token_manager import TokenManager
from github_webhook import handle_github_event
from storage import SQLiteStorage, RedisStorage, StorageBackend
from notifications import (
    CompositeNotifier, TelegramNotifier,
    SlackNotifier, DiscordNotifier, WebhookNotifier,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp-dev-server")

# ── 전역 상태 ─────────────────────────────────────────────────────────────────

storage: StorageBackend | None = None
notifier: CompositeNotifier | None = None
token_mgr: TokenManager | None = None
sse_subscribers: list[asyncio.Queue] = []

mcp_server = Server("pickket-dev")


# ── 앱 수명 주기 ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global storage, notifier, token_mgr
    cfg = get_config()

    # Storage 초기화
    if cfg.storage.backend == "redis":
        import os
        redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
        storage = RedisStorage(redis_url=redis_url, db=cfg.storage.redis_db)
    else:
        storage = SQLiteStorage(db_path=cfg.storage.sqlite_path)
    await storage.connect()
    logger.info(f"Storage: {cfg.storage.backend}")

    # Notifier 초기화
    notifiers = [
        TelegramNotifier(
            cfg.notifications.telegram.bot_token,
            cfg.notifications.telegram.chat_id,
        ),
        SlackNotifier(cfg.notifications.slack.webhook_url),
        DiscordNotifier(cfg.notifications.discord.webhook_url),
        WebhookNotifier(cfg.notifications.webhook.url),
    ]
    notifier = CompositeNotifier(notifiers)

    # Token Manager
    token_mgr = TokenManager(storage)

    logger.info(f"MCP Dev Server 시작 — 프로젝트: {cfg.project}")
    yield

    await storage.disconnect()
    logger.info("MCP Dev Server 종료")


app = FastAPI(title="claude-team-sync", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://admin.pickket.kr", "https://admin-staging.pickket.kr", "http://localhost:3022"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 인증 헬퍼 ─────────────────────────────────────────────────────────────────

async def require_auth(request: Request) -> str:
    """Bearer 토큰 검증 → developer 이름 반환."""
    cfg = get_config()
    if not cfg.mcp_auth_token:
        import logging
        logging.getLogger(__name__).warning("MCP_AUTH_TOKEN not configured — rejecting request")
        raise HTTPException(status_code=401, detail="MCP_AUTH_TOKEN not configured")
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Authorization 헤더 필요")
    # MCP_AUTH_TOKEN is accepted directly as master token (for admin dashboard bootstrap)
    if token == cfg.mcp_auth_token:
        return "admin"
    developer = await token_mgr.validate_token(token)
    if not developer:
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰")
    return developer


async def require_admin(request: Request) -> None:
    cfg = get_config()
    admin_key = request.headers.get("X-Admin-Key", "")
    if cfg.admin_key and admin_key != cfg.admin_key:
        raise HTTPException(status_code=403, detail="관리자 권한 필요")


# ── SSE 브로드캐스트 헬퍼 ──────────────────────────────────────────────────────

async def broadcast(event_type: str, data: dict) -> None:
    payload = f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
    dead = []
    for q in sse_subscribers:
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        sse_subscribers.remove(q)


def _now() -> str:
    return datetime.utcnow().isoformat()


# ── MCP 툴 정의 ───────────────────────────────────────────────────────────────

@mcp_server.list_tools()
async def list_tools() -> list[mcp_types.Tool]:
    return [
        mcp_types.Tool(
            name="dev_status",
            description="팀 전체 개발 현황 조회. 세션 시작 시 반드시 호출.",
            inputSchema={"type": "object", "properties": {}},
        ),
        mcp_types.Tool(
            name="claim_task",
            description="작업 시작 선언. 편집할 파일 목록과 브랜치를 등록해 팀에 알림.",
            inputSchema={
                "type": "object",
                "required": ["developer", "description", "files"],
                "properties": {
                    "developer": {"type": "string", "description": "개발자 이름"},
                    "description": {"type": "string", "description": "작업 설명"},
                    "files": {"type": "array", "items": {"type": "string"}, "description": "편집 예정 파일 목록"},
                    "branch": {"type": "string", "description": "Git 브랜치명"},
                },
            },
        ),
        mcp_types.Tool(
            name="update_progress",
            description="작업 진행 상황 업데이트.",
            inputSchema={
                "type": "object",
                "required": ["task_id", "message"],
                "properties": {
                    "task_id": {"type": "string"},
                    "message": {"type": "string"},
                    "status": {"type": "string", "enum": ["in_progress", "blocked", "review_needed"]},
                },
            },
        ),
        mcp_types.Tool(
            name="complete_task",
            description="작업 완료 선언. handoff note를 남겨 다음 세션/팀원이 이어받을 수 있게 함.",
            inputSchema={
                "type": "object",
                "required": ["task_id", "summary"],
                "properties": {
                    "task_id": {"type": "string"},
                    "summary": {"type": "string", "description": "완료 내용 요약"},
                    "next_steps": {"type": "string", "description": "다음에 할 일"},
                    "pr_url": {"type": "string", "description": "관련 PR URL"},
                },
            },
        ),
        mcp_types.Tool(
            name="check_conflicts",
            description="파일 충돌 여부 확인. 편집 전 호출 권장.",
            inputSchema={
                "type": "object",
                "required": ["files"],
                "properties": {
                    "files": {"type": "array", "items": {"type": "string"}},
                },
            },
        ),
        mcp_types.Tool(
            name="post_blocker",
            description="블로커 등록. 팀에 Telegram 알림 전송.",
            inputSchema={
                "type": "object",
                "required": ["developer", "issue"],
                "properties": {
                    "developer": {"type": "string"},
                    "issue": {"type": "string"},
                    "severity": {"type": "string", "enum": ["low", "high", "critical"], "default": "high"},
                },
            },
        ),
        mcp_types.Tool(
            name="force_unlock",
            description="긴급 파일 락 강제 해제. 이유 기록 필수. Telegram 알림 전송.",
            inputSchema={
                "type": "object",
                "required": ["file", "reason", "developer"],
                "properties": {
                    "file": {"type": "string"},
                    "reason": {"type": "string"},
                    "developer": {"type": "string"},
                },
            },
        ),
    ]


@mcp_server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[mcp_types.TextContent]:
    cfg = get_config()

    if name == "dev_status":
        tasks = await storage.get_active_tasks()
        locks = await storage.get_all_locks()
        handoffs = await storage.get_handoffs(limit=5)
        blockers = await storage.get_blockers(limit=5)

        lines = [f"=== {cfg.project} 팀 현황 ===\n"]

        if tasks:
            lines.append("【 활성 작업 】")
            for t in tasks:
                files_str = ", ".join(t.get("files", [])[:3])
                if len(t.get("files", [])) > 3:
                    files_str += f" 외 {len(t['files']) - 3}개"
                lines.append(
                    f"  • {t.get('developer', '?')} [{t.get('branch', '-')}]\n"
                    f"    {t.get('description', '')}\n"
                    f"    파일: {files_str or '없음'}"
                )
        else:
            lines.append("【 활성 작업 】 없음")

        if locks:
            lines.append("\n【 잠긴 파일 】")
            for fp, lock in list(locks.items())[:10]:
                lines.append(f"  • {fp} → {lock.get('developer', '?')} ({lock.get('branch', '-')})")

        if blockers:
            lines.append("\n【 블로커 】")
            for b in blockers:
                lines.append(f"  🚨 [{b.get('severity', 'high')}] {b.get('developer', '?')}: {b.get('issue', '')}")

        if handoffs:
            lines.append("\n【 최근 완료 】")
            for h in handoffs:
                lines.append(f"  ✅ {h.get('developer', '?')}: {h.get('summary', '')}")
                if h.get("next_steps"):
                    lines.append(f"     다음: {h['next_steps']}")

        return [mcp_types.TextContent(type="text", text="\n".join(lines))]

    elif name == "claim_task":
        task_id = str(uuid.uuid4())[:8]
        developer = arguments["developer"]
        description = arguments["description"]
        raw_files = arguments.get("files", [])
        branch = arguments.get("branch", "")

        # 파일 경로 정규화
        files = [normalize_path(f, cfg.project_root) for f in raw_files]

        task = {
            "id": task_id,
            "developer": developer,
            "description": description,
            "files": files,
            "branch": branch,
            "status": "in_progress",
            "started_at": _now(),
            "notes": [],
        }
        ttl = cfg.lock_ttl_hours * 3600 * 6  # 태스크 TTL = 락 TTL * 6
        await storage.create_task(task_id, task, ttl_seconds=ttl)

        # 파일 락 등록
        lock_ttl = cfg.lock_ttl_hours * 3600
        for fp in files:
            await storage.set_lock(fp, task_id, developer, branch, lock_ttl)

        await storage.log_event("task_claimed", task)
        await broadcast("task_claimed", task)

        return [mcp_types.TextContent(
            type="text",
            text=f"✅ 작업 등록 완료\nID: {task_id}\n파일 {len(files)}개 락 등록됨\n팀 대시보드에 표시됩니다."
        )]

    elif name == "update_progress":
        task_id = arguments["task_id"]
        message = arguments["message"]
        status = arguments.get("status", "in_progress")

        task = await storage.get_task(task_id)
        if not task:
            return [mcp_types.TextContent(type="text", text=f"태스크 {task_id}를 찾을 수 없습니다.")]

        task.setdefault("notes", []).append({"message": message, "timestamp": _now()})
        task["status"] = status
        await storage.update_task(task_id, task)
        await storage.log_event("task_updated", task)
        await broadcast("task_updated", task)

        return [mcp_types.TextContent(type="text", text=f"진행 상황 업데이트됨: {message}")]

    elif name == "complete_task":
        task_id = arguments["task_id"]
        summary = arguments["summary"]
        next_steps = arguments.get("next_steps", "")
        pr_url = arguments.get("pr_url", "")

        task = await storage.get_task(task_id)
        if not task:
            return [mcp_types.TextContent(type="text", text=f"태스크 {task_id}를 찾을 수 없습니다.")]

        task["status"] = "completed"
        task["completed_at"] = _now()
        task["summary"] = summary
        task["next_steps"] = next_steps
        if pr_url:
            task["pr_url"] = pr_url

        await storage.update_task(task_id, task)

        # 파일 락 해제
        for fp in task.get("files", []):
            await storage.release_lock(fp)

        # Handoff 기록
        handoff = {
            "task_id": task_id,
            "developer": task.get("developer", "?"),
            "description": task.get("description", ""),
            "summary": summary,
            "next_steps": next_steps,
            "pr_url": pr_url,
            "branch": task.get("branch", ""),
            "timestamp": _now(),
        }
        await storage.push_handoff(handoff)
        await storage.log_event("task_completed", task)
        await broadcast("task_completed", {**task, "handoff": handoff})

        # 알림
        msg_parts = [
            f"✅ <b>작업 완료</b>",
            f"개발자: {task.get('developer', '?')}  |  브랜치: {task.get('branch', '-')}",
            f"내용: {summary}",
        ]
        if next_steps:
            msg_parts.append(f"다음: {next_steps}")
        if pr_url:
            msg_parts.append(f"PR: {pr_url}")
        await notifier.send("\n".join(msg_parts))

        return [mcp_types.TextContent(
            type="text",
            text=f"✅ 작업 완료 처리됨\nHandoff note 저장됨\n파일 락 해제됨\n팀에 알림 전송됨"
        )]

    elif name == "check_conflicts":
        files = arguments.get("files", [])
        cfg_root = cfg.project_root
        conflicts = []
        for f in files:
            norm = normalize_path(f, cfg_root)
            lock = await storage.get_lock(norm)
            if lock:
                conflicts.append({
                    "file": norm,
                    "owner": lock.get("developer", "?"),
                    "branch": lock.get("branch", "-"),
                    "locked_at": lock.get("locked_at", ""),
                })

        if conflicts:
            lines = ["⚠️ 충돌 감지:"]
            for c in conflicts:
                lines.append(f"  • {c['file']} → {c['owner']} ({c['branch']})")
            lines.append("\nforce_unlock 으로 강제 해제하거나 해당 팀원과 협의하세요.")
            return [mcp_types.TextContent(type="text", text="\n".join(lines))]
        return [mcp_types.TextContent(type="text", text=f"✅ 충돌 없음 — {len(files)}개 파일 편집 가능")]

    elif name == "post_blocker":
        developer = arguments["developer"]
        issue = arguments["issue"]
        severity = arguments.get("severity", "high")
        blocker_id = str(uuid.uuid4())[:8]

        blocker = {
            "id": blocker_id,
            "developer": developer,
            "issue": issue,
            "severity": severity,
            "timestamp": _now(),
            "resolved": False,
        }
        await storage.push_blocker(blocker)
        await storage.log_event("blocker_posted", blocker)
        await broadcast("blocker_posted", blocker)

        severity_emoji = {"low": "⚠️", "high": "🚨", "critical": "🆘"}.get(severity, "🚨")
        msg = (
            f"{severity_emoji} <b>블로커 ({severity})</b>\n"
            f"개발자: {developer}\n"
            f"내용: {issue}"
        )
        await notifier.send(msg)

        return [mcp_types.TextContent(
            type="text",
            text=f"블로커 등록됨 (ID: {blocker_id})\n팀에 알림 전송됨"
        )]

    elif name == "force_unlock":
        file_path = arguments["file"]
        reason = arguments["reason"]
        developer = arguments["developer"]
        cfg_root = cfg.project_root

        norm = normalize_path(file_path, cfg_root)
        lock = await storage.get_lock(norm)
        original_owner = lock.get("developer", "?") if lock else "없음"

        released = await storage.release_lock(norm)
        await storage.log_event("force_unlock", {
            "file": norm,
            "released_by": developer,
            "original_owner": original_owner,
            "reason": reason,
            "timestamp": _now(),
        })
        await broadcast("lock_released", {"file": norm, "developer": developer})

        msg = (
            f"🔓 <b>강제 언락</b>\n"
            f"파일: {norm}\n"
            f"해제: {developer}\n"
            f"원 소유자: {original_owner}\n"
            f"사유: {reason}"
        )
        await notifier.send(msg)

        status = "해제됨" if released else "락 없음 (이미 해제됨)"
        return [mcp_types.TextContent(
            type="text",
            text=f"🔓 {norm} — {status}\n원 소유자: {original_owner}\n팀에 알림 전송됨"
        )]

    return [mcp_types.TextContent(type="text", text=f"알 수 없는 툴: {name}")]


# ── MCP SSE 엔드포인트 ────────────────────────────────────────────────────────

sse_transport = SseServerTransport("/messages")


@app.get("/sse")
async def mcp_sse_endpoint(request: Request):
    developer = await require_auth(request)
    logger.info(f"MCP 연결: {developer}")
    async with sse_transport.connect_sse(
        request.scope, request.receive, request._send
    ) as streams:
        await mcp_server.run(
            streams[0], streams[1],
            mcp_server.create_initialization_options(),
        )


@app.post("/messages")
async def mcp_messages_endpoint(request: Request):
    await require_auth(request)
    await sse_transport.handle_post_message(request.scope, request.receive, request._send)


# ── REST API ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "project": get_config().project}


@app.get("/api/status")
async def api_status(developer: str = Depends(require_auth)):
    cfg = get_config()
    tasks = await storage.get_active_tasks()
    locks = await storage.get_all_locks()
    handoffs = await storage.get_handoffs(limit=10)
    blockers = await storage.get_blockers()
    return {
        "project": cfg.project,
        "tasks": tasks,
        "locks": locks,
        "handoffs": handoffs,
        "blockers": blockers,
        "timestamp": _now(),
    }


@app.get("/api/conflicts")
async def api_conflicts(files: str, developer: str = Depends(require_auth)):
    cfg = get_config()
    file_list = [f.strip() for f in files.split(",") if f.strip()]
    conflicts = []
    for f in file_list:
        norm = normalize_path(f, cfg.project_root)
        lock = await storage.get_lock(norm)
        if lock:
            conflicts.append({"file": norm, "owner": lock.get("developer"), "branch": lock.get("branch")})
    return {"conflicts": conflicts, "has_conflict": len(conflicts) > 0}


class LockRequest(BaseModel):
    file: str
    branch: str = ""
    developer: str = ""
    task_id: str = ""


@app.post("/api/locks")
async def api_set_lock(body: LockRequest, developer: str = Depends(require_auth)):
    cfg = get_config()
    norm = normalize_path(body.file, cfg.project_root)
    dev = body.developer or developer
    await storage.set_lock(
        norm, body.task_id or "hook", dev,
        body.branch, cfg.lock_ttl_hours * 3600
    )
    await broadcast("lock_acquired", {"file": norm, "developer": dev, "branch": body.branch})
    return {"ok": True, "file": norm}


@app.delete("/api/locks")
async def api_release_lock(file: str, developer: str = Depends(require_auth)):
    cfg = get_config()
    norm = normalize_path(file, cfg.project_root)
    released = await storage.release_lock(norm)
    return {"ok": released, "file": norm}


class TaskRequest(BaseModel):
    developer: str
    description: str
    files: list[str] = []
    branch: str = ""


@app.post("/api/tasks")
async def api_create_task(body: TaskRequest, developer: str = Depends(require_auth)):
    cfg = get_config()
    task_id = str(uuid.uuid4())[:8]
    files = [normalize_path(f, cfg.project_root) for f in body.files]
    task = {
        "id": task_id,
        "developer": body.developer or developer,
        "description": body.description,
        "files": files,
        "branch": body.branch,
        "status": "in_progress",
        "started_at": _now(),
    }
    await storage.create_task(task_id, task, cfg.lock_ttl_hours * 3600 * 6)
    for fp in files:
        await storage.set_lock(fp, task_id, task["developer"], body.branch, cfg.lock_ttl_hours * 3600)
    await broadcast("task_claimed", task)
    return task


@app.patch("/api/tasks/{task_id}")
async def api_update_task(task_id: str, body: dict, developer: str = Depends(require_auth)):
    task = await storage.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="태스크를 찾을 수 없음")
    task.update(body)
    await storage.update_task(task_id, task)
    await broadcast("task_updated", task)
    return task


class BlockerRequest(BaseModel):
    developer: str
    issue: str
    severity: str = "high"


@app.post("/api/blockers")
async def api_post_blocker(body: BlockerRequest, developer: str = Depends(require_auth)):
    blocker_id = str(uuid.uuid4())[:8]
    severity_emoji = {"low": "⚠️", "high": "🚨", "critical": "🆘"}.get(body.severity, "🚨")
    blocker = {
        "id": blocker_id,
        "developer": body.developer or developer,
        "issue": body.issue,
        "severity": body.severity,
        "timestamp": _now(),
        "resolved": False,
    }
    await storage.push_blocker(blocker)
    await broadcast("blocker_posted", blocker)
    msg = f"{severity_emoji} <b>블로커 ({body.severity})</b>\n개발자: {blocker['developer']}\n내용: {body.issue}"
    await notifier.send(msg)
    return blocker


@app.patch("/api/blockers/{blocker_id}/resolve")
async def api_resolve_blocker(blocker_id: str, developer: str = Depends(require_auth)):
    ok = await storage.resolve_blocker(blocker_id)
    return {"ok": ok}


@app.get("/api/timeline")
async def api_timeline(hours: int = 24, developer: str = Depends(require_auth)):
    events = await storage.get_events(hours=min(hours, 48))
    return {"events": events}


# ── 토큰 관리 API (관리자 전용) ────────────────────────────────────────────────

@app.get("/api/tokens")
async def api_list_tokens(request: Request):
    await require_admin(request)
    tokens = await token_mgr.list_tokens()
    return {"tokens": tokens}


class TokenCreateRequest(BaseModel):
    developer: str


@app.post("/api/tokens")
async def api_create_token(body: TokenCreateRequest, request: Request):
    await require_admin(request)
    token = await token_mgr.generate_token(body.developer)
    return {"token": token, "developer": body.developer, "note": "이 값은 한 번만 표시됩니다."}


@app.delete("/api/tokens/{token}")
async def api_revoke_token(token: str, request: Request):
    await require_admin(request)
    ok = await token_mgr.revoke_token(token)
    return {"ok": ok}


# ── 대시보드 SSE 스트림 ──────────────────────────────────────────────────────

@app.get("/events")
async def dashboard_sse(request: Request):
    """대시보드용 SSE 스트림. 팀 이벤트 실시간 전달."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    sse_subscribers.append(q)

    async def event_generator():
        # 초기 상태 전송
        try:
            tasks = await storage.get_active_tasks()
            locks = await storage.get_all_locks()
            blockers = await storage.get_blockers()
            handoffs = await storage.get_handoffs(limit=10)
            initial = {
                "tasks": tasks,
                "locks": locks,
                "blockers": blockers,
                "handoffs": handoffs,
            }
            yield f"event: init\ndata: {json.dumps(initial, ensure_ascii=False)}\n\n"
        except Exception:
            pass

        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=30)
                    yield payload
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if q in sse_subscribers:
                sse_subscribers.remove(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── GitHub Webhook ────────────────────────────────────────────────────────────

@app.post("/webhooks/github")
async def github_webhook_endpoint(request: Request):
    cfg = get_config()
    return await handle_github_event(request, storage, notifier, cfg.github.webhook_secret)


# ── 진입점 ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    cfg = get_config()
    uvicorn.run("server:app", host="0.0.0.0", port=cfg.port, reload=False)
