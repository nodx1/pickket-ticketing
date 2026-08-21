"""SNS → Telegram 알림 전달 Lambda.

CloudWatch Alarm → SNS → 이 Lambda → Telegram Bot API.
환경변수:
  TELEGRAM_BOT_TOKEN: Bot API 토큰
  TELEGRAM_CHAT_ID: 기본 채팅방 (fallback)
  TELEGRAM_CHAT_CRITICAL: critical 알림 채팅방
  TELEGRAM_CHAT_WARNING: warning 알림 채팅방
"""

import json
import os
import urllib.request
import urllib.error

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
CHAT_CRITICAL = os.environ.get("TELEGRAM_CHAT_CRITICAL", "")
CHAT_WARNING = os.environ.get("TELEGRAM_CHAT_WARNING", "")

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"


def _resolve_chat(alarm_state):
    """알람 상태에 따라 채팅방 결정."""
    if alarm_state == "ALARM":
        return CHAT_CRITICAL or CHAT_ID
    return CHAT_WARNING or CHAT_ID


def _format_alarm_message(message):
    """CloudWatch Alarm SNS 메시지 → Telegram HTML."""
    try:
        data = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return f"📢 <b>SNS Alert</b>\n\n<code>{str(message)[:1000]}</code>", CHAT_ID

    alarm_name = data.get("AlarmName", "Unknown")
    new_state = data.get("NewStateValue", "UNKNOWN")
    reason = data.get("NewStateReason", "")
    old_state = data.get("OldStateValue", "")
    region = data.get("Region", "")
    timestamp = data.get("StateChangeTime", "")

    emoji = "🚨" if new_state == "ALARM" else "✅" if new_state == "OK" else "❓"
    level = "CRITICAL" if new_state == "ALARM" else "RESOLVED"

    lines = [
        f"{emoji} <b>[{level}] {alarm_name}</b>",
        "",
        f"• <b>상태</b>: <code>{old_state}</code> → <code>{new_state}</code>",
        f"• <b>시간</b>: <code>{timestamp}</code>",
        f"• <b>리전</b>: <code>{region}</code>",
        "",
        f"<b>사유:</b>",
        f"<code>{reason[:500]}</code>",
    ]

    chat = _resolve_chat(new_state)
    return "\n".join(lines), chat


def handler(event, context):
    """Lambda 핸들러 — SNS 이벤트 수신."""
    if not BOT_TOKEN or not CHAT_ID:
        print("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set")
        return {"statusCode": 400, "body": "Missing Telegram config"}

    for record in event.get("Records", []):
        sns = record.get("Sns", {})
        message = sns.get("Message", "")
        subject = sns.get("Subject", "")

        text, chat_id = _format_alarm_message(message)

        payload = json.dumps({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }).encode("utf-8")

        req = urllib.request.Request(
            TELEGRAM_API,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                print(f"Telegram sent: {resp.status} for alarm: {subject}")
        except urllib.error.URLError as e:
            print(f"Telegram send failed: {e}")

    return {"statusCode": 200, "body": "OK"}
