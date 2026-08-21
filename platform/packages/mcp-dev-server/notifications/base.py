from abc import ABC, abstractmethod


class Notifier(ABC):
    @abstractmethod
    async def send(self, message: str) -> None: ...

    @property
    @abstractmethod
    def enabled(self) -> bool: ...


class CompositeNotifier(Notifier):
    """여러 알림 채널을 하나로 묶어 동시에 전송."""

    def __init__(self, notifiers: list[Notifier]):
        self._notifiers = notifiers

    @property
    def enabled(self) -> bool:
        return any(n.enabled for n in self._notifiers)

    async def send(self, message: str) -> None:
        import asyncio
        active = [n for n in self._notifiers if n.enabled]
        if active:
            await asyncio.gather(*[n.send(message) for n in active], return_exceptions=True)
