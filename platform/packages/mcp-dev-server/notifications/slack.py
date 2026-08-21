import httpx
from .base import Notifier


class SlackNotifier(Notifier):
    def __init__(self, webhook_url: str):
        self._webhook_url = webhook_url

    @property
    def enabled(self) -> bool:
        return bool(self._webhook_url)

    async def send(self, message: str) -> None:
        if not self.enabled:
            return
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                await client.post(self._webhook_url, json={"text": message})
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning("Notification delivery failed: %s", e)
