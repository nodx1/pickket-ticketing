import hashlib
import hmac
from fastapi import Request, HTTPException


def verify_github_signature(payload: bytes, signature: str, secret: str) -> bool:
    """GitHub Webhook 시그니처 검증."""
    if not secret:
        return True  # 시크릿 미설정 시 검증 생략
    expected = "sha256=" + hmac.new(
        secret.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


async def handle_github_event(
    request: Request,
    storage,
    notifier,
    webhook_secret: str,
) -> dict:
    payload_bytes = await request.body()
    signature = request.headers.get("X-Hub-Signature-256", "")

    if not verify_github_signature(payload_bytes, signature, webhook_secret):
        raise HTTPException(status_code=401, detail="Invalid signature")

    event_type = request.headers.get("X-GitHub-Event", "")
    payload = await request.json()

    if event_type == "pull_request":
        await _handle_pull_request(payload, storage, notifier)
    elif event_type == "push":
        await _handle_push(payload, storage)

    return {"ok": True}


async def _handle_pull_request(payload: dict, storage, notifier) -> None:
    action = payload.get("action", "")
    pr = payload.get("pull_request", {})
    branch = pr.get("head", {}).get("ref", "")
    pr_url = pr.get("html_url", "")
    pr_title = pr.get("title", "")
    pr_author = pr.get("user", {}).get("login", "")
    merged = pr.get("merged", False)

    if not branch:
        return

    task = await storage.find_task_by_branch(branch)

    if action == "opened" and task:
        await storage.link_pr(task["id"], pr_url)
        await storage.log_event("pr_linked", {
            "task_id": task["id"],
            "pr_url": pr_url,
            "branch": branch,
        })
        msg = (
            f"🔗 <b>PR 연결됨</b>\n"
            f"개발자: {task.get('developer', '?')}\n"
            f"작업: {task.get('description', '?')}\n"
            f"PR: <a href='{pr_url}'>{pr_title}</a>"
        )
        await notifier.send(msg)

    elif action == "closed" and merged:
        if task:
            task["status"] = "completed"
            task["completed_at"] = _now()
            task["summary"] = f"PR merged: {pr_url}"
            await storage.update_task(task["id"], task)
            await storage.push_handoff({
                "task_id": task["id"],
                "developer": task.get("developer", "?"),
                "summary": f"PR 머지 완료: {pr_title}",
                "pr_url": pr_url,
                "timestamp": _now(),
            })
            # 파일 락 해제
            for fp in task.get("files", []):
                await storage.release_lock(fp)
            await storage.log_event("task_completed", task)

        msg = (
            f"✅ <b>PR 머지 완료</b>\n"
            f"브랜치: {branch}\n"
            f"PR: <a href='{pr_url}'>{pr_title}</a>\n"
            f"작성자: {pr_author}"
        )
        await notifier.send(msg)


async def _handle_push(payload: dict, storage) -> None:
    # push 이벤트에서 삭제된 브랜치 처리 (락 정리)
    ref = payload.get("ref", "")
    if payload.get("deleted") and ref.startswith("refs/heads/"):
        branch = ref.replace("refs/heads/", "")
        task = await storage.find_task_by_branch(branch)
        if task:
            for fp in task.get("files", []):
                await storage.release_lock(fp)


def _now() -> str:
    from datetime import datetime
    return datetime.utcnow().isoformat()
