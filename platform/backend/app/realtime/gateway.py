"""실시간 게이트웨이 — Socket.IO (과업 WP6 "실시간 소켓 통신(Socket.IO)을 통해 현장 입장권을 검증하고,
부정 거래 탐지 내역을 선정된 현장 단말과 동기화").

FastAPI 앱의 /ws 아래에 마운트된다:  ws(s)://<api>/ws/socket.io/   (transports=["websocket"] 권장)

네임스페이스
    /terminal   현장 단말. auth={"key": "pkt_term_..."} 로 접속 → 이벤트·게이트 방에 들어간다.
                단말 → 서버   scan {payload, manual?, scanned_at?}  (ack 로 판정 결과)
                              heartbeat {}
                서버 → 단말   blocklist.sync   차단 티켓·제재 계정 티켓 목록(접속 즉시 + 변경 시)
                              fraud.alert      같은 이벤트 다른 단말에서 탐지된 부정 시도
                              ticket.admitted  다른 게이트 입장(오프라인 캐시용)
                              permission.update 이 단말의 게이트·허용 등급·상태 변경
    /monitor    주최사 대시보드. auth={"token": <서버가 발급한 단기 토큰>} → 이벤트 방.
                서버 → 대시보드  admission, fraud.alert, terminal.status, sanction, blocklist.sync

다중 워커: REALTIME_REDIS_MANAGER=True 면 Redis pub/sub 로 워커 간 방송을 맞춘다.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import time
import uuid

import socketio

from app.core.config import settings
from app.core.database import async_session

logger = logging.getLogger(__name__)

# 세션 팩토리(테스트에서 바꿔 끼운다)
session_factory = async_session

MONITOR_TOKEN_TTL = 3600


def _origins() -> list[str] | str:
    raw = settings.REALTIME_CORS_ORIGINS.strip()
    if raw == "*":
        return "*"
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    return settings.cors_origins_list


def _manager():
    if not settings.REALTIME_REDIS_MANAGER or os.environ.get("PYTEST_CURRENT_TEST"):
        return None
    try:
        return socketio.AsyncRedisManager(settings.REDIS_URL, channel="v2:realtime:socketio")
    except Exception:
        logger.warning("Socket.IO Redis manager unavailable — single worker mode", exc_info=True)
        return None


sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=_origins(),
    client_manager=_manager(),
    logger=False,
    engineio_logger=False,
)
_socketio_asgi = socketio.ASGIApp(sio, socketio_path="socket.io")


async def asgi_app(scope, receive, send):
    """FastAPI `app.mount("/ws", ...)` 용 래퍼.

    Starlette 1.x 는 마운트된 앱에 전체 경로(`/ws/socket.io/`)와 root_path(`/ws`)를 함께 넘긴다.
    engine.io 는 `/socket.io/` 로 시작하는 경로만 받으므로 root_path 를 떼어 넘긴다
    (예전 Starlette 처럼 이미 떼어 주는 경우에도 그대로 동작).
    """
    if scope.get("type") in ("http", "websocket"):
        root = scope.get("root_path") or ""
        path = scope.get("path") or ""
        if root and path.startswith(root):
            scope = {**scope, "path": path[len(root):] or "/"}
    await _socketio_asgi(scope, receive, send)


# ───────── 대시보드 토큰 ─────────


def issue_monitor_token(event_id: uuid.UUID, ttl: int = MONITOR_TOKEN_TTL) -> dict:
    exp = int(time.time()) + ttl
    body = f"{event_id}.{exp}"
    sig = hmac.new(settings.SECRET_KEY.encode(), f"monitor|{body}".encode(), hashlib.sha256).digest()
    token = f"{body}.{base64.urlsafe_b64encode(sig).decode().rstrip('=')}"
    return {"token": token, "expires_at": exp, "event_id": str(event_id)}


def verify_monitor_token(token: str | None) -> uuid.UUID | None:
    try:
        event_text, exp_text, sig_text = (token or "").split(".")
        if int(exp_text) < time.time():
            return None
        expected = hmac.new(
            settings.SECRET_KEY.encode(), f"monitor|{event_text}.{exp_text}".encode(), hashlib.sha256
        ).digest()
        given = base64.urlsafe_b64decode(sig_text + "=" * (-len(sig_text) % 4))
        if not hmac.compare_digest(expected, given):
            return None
        return uuid.UUID(event_text)
    except (ValueError, TypeError):
        return None


# ───────── 방송 ─────────


async def publish(kind: str, event_id: uuid.UUID, payload: dict) -> None:
    room = f"event:{event_id}"
    if kind == "admission":
        await sio.emit("admission", payload, room=room, namespace="/monitor")
        if payload.get("result") in ("admitted", "reentry_ok"):
            await sio.emit(
                "ticket.admitted",
                {"ticket_no": payload.get("ticket_no"), "gate": payload.get("gate"), "at": payload.get("at")},
                room=room,
                namespace="/terminal",
            )
    elif kind == "fraud":
        await sio.emit("fraud.alert", payload, room=room, namespace="/monitor")
        await sio.emit("fraud.alert", payload, room=room, namespace="/terminal")
    elif kind == "blocklist":
        await sio.emit("blocklist.sync", payload, room=room, namespace="/terminal")
        await sio.emit("blocklist.sync", payload, room=room, namespace="/monitor")
    elif kind == "permission":
        await sio.emit("permission.update", payload, room=f"terminal:{payload.get('terminal_id')}", namespace="/terminal")
        await sio.emit("terminal.status", payload, room=room, namespace="/monitor")
        # 중지·폐기, 또는 키를 새로 발급(입장 링크 새로 만들기)했으면 예전 키로 붙어 있던 기기를 끊는다.
        if payload.get("status") in ("suspended", "revoked") or payload.get("rekeyed"):
            await sio.disconnect_room(f"terminal:{payload.get('terminal_id')}", namespace="/terminal") if hasattr(sio, "disconnect_room") else None
    elif kind == "terminal":
        await sio.emit("terminal.status", payload, room=room, namespace="/monitor")
    elif kind == "sanction":
        await sio.emit("sanction", payload, room=room, namespace="/monitor")


async def publish_sanction(row) -> None:
    """SanctionService 가 부르는 훅 — 제재가 생기면 대시보드에 알리고 단말 차단 목록을 다시 보낸다."""
    if row.event_id is None:
        return
    await publish(
        "sanction",
        row.event_id,
        {"id": str(row.id), "action": row.action, "reason_code": row.reason_code, "ap_burned": row.ap_burned},
    )
    if row.action == "impose":
        from app.services.onsite_service import OnsiteService

        async with session_factory() as db:
            await publish("blocklist", row.event_id, await OnsiteService(db).blocklist(row.event_id))


# ───────── /terminal ─────────


class TerminalNamespace(socketio.AsyncNamespace):
    async def on_connect(self, sid, environ, auth=None):
        from app.services.onsite_service import OnsiteService

        key = (auth or {}).get("key") if isinstance(auth, dict) else None
        key = key or environ.get("HTTP_X_TERMINAL_KEY")
        async with session_factory() as db:
            service = OnsiteService(db)
            terminal, reason = await service.check_key(key)
            if terminal is None:
                # 단말 화면이 「사용 중지」와 「행사 끝나 닫힘」을 구분해 안내하도록 이유를 붙인다(키 자체는 안 돌려준다).
                raise socketio.exceptions.ConnectionRefusedError(f"unauthorized terminal: {reason}")
            await service.heartbeat(terminal)
            blocklist = await service.blocklist(terminal.event_id)
            info = {"terminal_id": str(terminal.id), "event_id": str(terminal.event_id), "gate": terminal.gate, "name": terminal.name, "kind": terminal.kind}
            await db.commit()
        await self.save_session(sid, {**info, "key": key})
        await self.enter_room(sid, f"event:{info['event_id']}")
        await self.enter_room(sid, f"terminal:{info['terminal_id']}")
        await self.emit("hello", info, to=sid)
        await self.emit("blocklist.sync", blocklist, to=sid)
        await publish("terminal", uuid.UUID(info["event_id"]), {**info, "online": True})

    async def on_disconnect(self, sid, reason=None):
        try:
            session = await self.get_session(sid)
        except KeyError:
            return
        await publish("terminal", uuid.UUID(session["event_id"]), {**{k: v for k, v in session.items() if k != "key"}, "online": False})

    async def on_heartbeat(self, sid, data=None):
        from app.services.onsite_service import OnsiteService

        session = await self.get_session(sid)
        async with session_factory() as db:
            terminal = await OnsiteService(db).authenticate(session["key"])
            if terminal is None:
                await self.disconnect(sid)
                return {"ok": False}
            await OnsiteService(db).heartbeat(terminal)
            await db.commit()
        return {"ok": True, "server_time": time.time()}

    async def on_scan(self, sid, data):
        from datetime import datetime

        from app.services.onsite_service import OnsiteService

        session = await self.get_session(sid)
        data = data if isinstance(data, dict) else {}
        scanned_at = None
        if data.get("scanned_at"):
            try:
                scanned_at = datetime.fromisoformat(str(data["scanned_at"]))
            except ValueError:
                scanned_at = None
        async with session_factory() as db:
            service = OnsiteService(db)
            terminal = await service.authenticate(session["key"])
            if terminal is None:
                await self.disconnect(sid)
                return {"result": "rejected", "code": "terminal_revoked", "message": "사용이 중지된 단말입니다"}
            outcome = await service.scan(
                terminal, str(data.get("payload") or ""), manual=bool(data.get("manual")), scanned_at=scanned_at
            )
            await db.commit()
        return outcome.to_dict()


# ───────── /monitor ─────────


class MonitorNamespace(socketio.AsyncNamespace):
    async def on_connect(self, sid, environ, auth=None):
        token = (auth or {}).get("token") if isinstance(auth, dict) else None
        event_id = verify_monitor_token(token)
        if event_id is None:
            raise socketio.exceptions.ConnectionRefusedError("unauthorized monitor")
        await self.save_session(sid, {"event_id": str(event_id)})
        await self.enter_room(sid, f"event:{event_id}")
        await self.emit("hello", {"event_id": str(event_id)}, to=sid)


sio.register_namespace(TerminalNamespace("/terminal"))
sio.register_namespace(MonitorNamespace("/monitor"))


# ───────── 커밋 후 방송 ─────────


def publish_after_commit(session, factory) -> None:
    """DB 를 다시 읽는 방송(차단 목록 등)은 **커밋이 끝난 뒤에** 보낸다.

    커밋 전에 보내면 다른 세션이 아직 안 보이는 행을 읽어 단말에 낡은 목록이 간다.
    롤백되면 아예 보내지 않는다.
    """
    import asyncio

    from sqlalchemy import event as sa_event

    sync_session = getattr(session, "sync_session", None)
    if sync_session is None or os.environ.get("PYTEST_CURRENT_TEST"):
        return  # 단위 테스트는 SQLite 단일 연결 — 별도 세션 방송이 트랜잭션을 건드리지 않게 끈다

    def _after_commit(_session):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(factory())
        task.add_done_callback(lambda t: t.exception() and logger.warning("post-commit publish failed: %s", t.exception()))

    sa_event.listen(sync_session, "after_commit", _after_commit, once=True)
