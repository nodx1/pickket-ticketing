"""Resilience patterns: retry with exponential backoff and circuit breaker.

Uses tenacity for retry logic and implements a lightweight circuit breaker
using tenacity's stop/retry primitives.

Usage:
    from app.core.resilience import with_retry, circuit_breaker

    @with_retry(max_attempts=3, backoff_base=2)
    async def call_external_api():
        ...

    @circuit_breaker(failure_threshold=5, recovery_timeout=60)
    async def call_payment_gateway():
        ...
"""

from __future__ import annotations

import asyncio
import functools
import logging
import time
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])

# ── Retry decorator (tenacity-based) ────────────────────────────────────────


def with_retry(
    max_attempts: int = 3,
    backoff_base: float = 2.0,
    max_backoff: float = 30.0,
    retry_on: tuple[type[Exception], ...] = (Exception,),
    exclude: tuple[type[Exception], ...] = (ValueError, PermissionError, KeyError),
) -> Callable[[F], F]:
    """Decorator that retries with exponential backoff.

    Args:
        max_attempts: Maximum number of attempts (including the first).
        backoff_base: Base for exponential backoff in seconds.
        max_backoff: Maximum backoff delay in seconds.
        retry_on: Exception types to retry on.
        exclude: Exception types to never retry (raised immediately).
    """
    try:
        from tenacity import (
            retry,
            stop_after_attempt,
            wait_exponential,
            retry_if_exception_type,
            retry_if_not_exception_type,
            before_sleep_log,
        )

        def decorator(func: F) -> F:
            retry_decorator = retry(
                stop=stop_after_attempt(max_attempts),
                wait=wait_exponential(multiplier=1, min=1, max=max_backoff),
                retry=(retry_if_exception_type(retry_on) & retry_if_not_exception_type(exclude)),
                before_sleep=before_sleep_log(logger, logging.WARNING),
                reraise=True,
            )
            return retry_decorator(func)  # type: ignore[return-value]

        return decorator  # type: ignore[return-value]

    except ImportError:
        logger.warning("tenacity not installed; @with_retry is a no-op pass-through")

        def decorator(func: F) -> F:
            return func

        return decorator  # type: ignore[return-value]


# ── Circuit Breaker ─────────────────────────────────────────────────────────


class CircuitBreakerOpen(Exception):
    """Raised when the circuit breaker is open and calls are rejected."""

    def __init__(self, name: str, recovery_in: float):
        self.name = name
        self.recovery_in = recovery_in
        super().__init__(f"Circuit breaker '{name}' is OPEN; recovery in {recovery_in:.1f}s")


class _CircuitBreakerState:
    """Lightweight in-process circuit breaker state machine.

    States:
        CLOSED  -- normal operation, requests pass through
        OPEN    -- too many failures, requests rejected immediately
        HALF_OPEN -- after recovery_timeout, one probe request allowed
    """

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

    def __init__(self, name: str, failure_threshold: int, recovery_timeout: float):
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.state = self.CLOSED
        self.failure_count = 0
        self.last_failure_time: float = 0.0
        self._lock = asyncio.Lock()

    async def before_call(self) -> None:
        """Check circuit state before making the call."""
        async with self._lock:
            if self.state == self.CLOSED:
                return

            if self.state == self.OPEN:
                elapsed = time.monotonic() - self.last_failure_time
                if elapsed >= self.recovery_timeout:
                    self.state = self.HALF_OPEN
                    logger.info("Circuit breaker '%s' → HALF_OPEN (probing)", self.name)
                    return
                raise CircuitBreakerOpen(self.name, self.recovery_timeout - elapsed)

            # HALF_OPEN: allow the probe call
            return

    async def on_success(self) -> None:
        """Record a successful call."""
        async with self._lock:
            if self.state in (self.HALF_OPEN, self.OPEN):
                logger.info("Circuit breaker '%s' → CLOSED (recovered)", self.name)
            self.state = self.CLOSED
            self.failure_count = 0

    async def on_failure(self) -> None:
        """Record a failed call."""
        async with self._lock:
            self.failure_count += 1
            self.last_failure_time = time.monotonic()

            if self.state == self.HALF_OPEN:
                self.state = self.OPEN
                logger.warning("Circuit breaker '%s' → OPEN (half-open probe failed)", self.name)
                return

            if self.failure_count >= self.failure_threshold:
                self.state = self.OPEN
                logger.warning(
                    "Circuit breaker '%s' → OPEN (failures=%d >= threshold=%d)",
                    self.name,
                    self.failure_count,
                    self.failure_threshold,
                )


# Global registry so the same circuit breaker instance is shared across calls
_breaker_registry: dict[str, _CircuitBreakerState] = {}


def circuit_breaker(
    failure_threshold: int = 5,
    recovery_timeout: float = 60.0,
    name: str | None = None,
) -> Callable[[F], F]:
    """Decorator that wraps an async function with circuit breaker protection.

    Args:
        failure_threshold: Number of consecutive failures before opening.
            환경변수 CIRCUIT_BREAKER_{NAME}_THRESHOLD로 오버라이드 가능.
        recovery_timeout: Seconds to wait before allowing a probe request.
            환경변수 CIRCUIT_BREAKER_{NAME}_TIMEOUT으로 오버라이드 가능.
        name: Optional name for the breaker (defaults to function qualname).
    """
    import os

    def decorator(func: F) -> F:
        breaker_name = name or func.__qualname__
        # 환경변수 오버라이드 (재배포 없이 동적 조정)
        env_prefix = f"CIRCUIT_BREAKER_{breaker_name.upper().replace('.', '_')}"
        effective_threshold = int(os.environ.get(f"{env_prefix}_THRESHOLD", failure_threshold))
        effective_timeout = float(os.environ.get(f"{env_prefix}_TIMEOUT", recovery_timeout))
        if breaker_name not in _breaker_registry:
            _breaker_registry[breaker_name] = _CircuitBreakerState(
                breaker_name, effective_threshold, effective_timeout
            )
        breaker = _breaker_registry[breaker_name]

        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            await breaker.before_call()
            try:
                result = await func(*args, **kwargs)
                await breaker.on_success()
                return result
            except CircuitBreakerOpen:
                raise
            except Exception:
                await breaker.on_failure()
                raise

        return wrapper  # type: ignore[return-value]

    return decorator  # type: ignore[return-value]
