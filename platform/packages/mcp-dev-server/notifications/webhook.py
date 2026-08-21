import httpx
from .base import Notifier


class WebhookNotifier(Notifier):
    def __init__(self, url: str):
        self._url = url

    @property
    def enabled(self) -> bool:
        return bool(self._url)

    async def send(self, message: str) -> None:
        if not self.enabled:
            return
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                await client.post(self._url, json={"message": message})
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning("Notification delivery failed: %s", e)
