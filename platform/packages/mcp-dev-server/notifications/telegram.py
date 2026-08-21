import httpx
from .base import Notifier


class TelegramNotifier(Notifier):
    def __init__(self, bot_token: str, chat_id: str):
        self._bot_token = bot_token
        self._chat_id = chat_id

    @property
    def enabled(self) -> bool:
        return bool(self._bot_token and self._chat_id)

    async def send(self, message: str) -> None:
        if not self.enabled:
            return
        url = f"https://api.telegram.org/bot{self._bot_token}/sendMessage"
        payload = {
            "chat_id": self._chat_id,
            "text": message,
            "parse_mode": "HTML",
        }
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                await client.post(url, json=payload)
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning("Notification delivery failed: %s", e)
