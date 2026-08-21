"""Structured logging configuration for Pickket backend.

- Production (ENVIRONMENT != "development"): JSON-formatted log lines suitable
  for log aggregation systems (ELK, Datadog, CloudWatch, etc.).
- Development: human-readable coloured text output.

Usage:
    from app.core.logging_config import setup_logging
    setup_logging()  # call once at application startup
"""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import datetime, timezone

from app.core.config import settings
from app.middleware.request_id import request_id_var


class JSONFormatter(logging.Formatter):
    """Emit each log record as a single JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }

        if record.exc_info and record.exc_info[0] is not None:
            log_entry["exception"] = self.formatException(record.exc_info)

        if hasattr(record, "request_id"):
            log_entry["request_id"] = record.request_id

        return json.dumps(log_entry, default=str)


class TextFormatter(logging.Formatter):
    """Readable coloured formatter for local development."""

    LEVEL_COLOURS = {
        "DEBUG": "\033[36m",  # cyan
        "INFO": "\033[32m",  # green
        "WARNING": "\033[33m",  # yellow
        "ERROR": "\033[31m",  # red
        "CRITICAL": "\033[1;31m",  # bold red
    }
    RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        colour = self.LEVEL_COLOURS.get(record.levelname, "")
        reset = self.RESET
        ts = datetime.fromtimestamp(record.created, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        base = f"{ts} {colour}{record.levelname:<8}{reset} [{record.name}] {record.getMessage()}"

        if record.exc_info and record.exc_info[0] is not None:
            base += "\n" + self.formatException(record.exc_info)

        return base


class RequestIdFilter(logging.Filter):
    def filter(self, record):
        record.request_id = request_id_var.get("")
        return True


class SensitiveDataFilter(logging.Filter):
    """로그 메시지에서 민감 정보를 마스킹하는 필터.

    마스킹 대상:
    - password, token, secret (키-값 패턴)
    - 주민등록번호 (XXXXXX-XXXXXXX)
    - 카드번호 (XXXX-XXXX-XXXX-XXXX)
    - 전화번호 (010-XXXX-XXXX)
    - 이메일 (user@domain.com)
    - API 키 / Bearer 토큰
    """

    PATTERNS = [
        # 기존: 키-값 기반 민감 필드
        (re.compile(r'(password["\s:=]+)[^\s,}"]+', re.I), r"\1***"),
        (re.compile(r'(token["\s:=]+)[^\s,}"]+', re.I), r"\1***"),
        (re.compile(r'(secret["\s:=]+)[^\s,}"]+', re.I), r"\1***"),
        (re.compile(r'(api[_-]?key["\s:=]+)[^\s,}"]+', re.I), r"\1***"),
        (re.compile(r'(authorization["\s:=]+Bearer\s+)\S+', re.I), r"\1***"),
        # 주민등록번호: 6자리-7자리 (1~4로 시작하는 뒷자리)
        (re.compile(r"\b(\d{6})-([1-4])\d{6}\b"), r"\1-\2******"),
        # 카드번호: 16자리 (4-4-4-4, 구분자: 하이픈, 공백, 또는 없음)
        (re.compile(r"\b(\d{4})[-\s]?\d{4}[-\s]?\d{4}[-\s]?(\d{4})\b"), r"\1-****-****-\2"),
        # 전화번호: 한국 휴대폰 (010, 011, 016, 017, 018, 019)
        (re.compile(r"\b(01[016789])-?(\d{3,4})-?(\d{4})\b"), r"\1-****-\3"),
        # 이메일: 로컬 부분 마스킹 (첫 2자만 보존)
        (re.compile(r"\b([\w.+-]{2})[\w.+-]*@([\w-]+\.[\w.]+)\b"), r"\1***@\2"),
    ]

    def filter(self, record):
        msg = record.getMessage()
        for pattern, replacement in self.PATTERNS:
            msg = pattern.sub(replacement, msg)
        record.msg = msg
        record.args = ()
        return True


def setup_logging() -> None:
    """Configure the root logger based on ``settings.ENVIRONMENT``."""
    environment = getattr(settings, "ENVIRONMENT", "development")
    log_level = logging.DEBUG if environment == "development" else logging.INFO

    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)

    # Remove any existing handlers to avoid duplicate output
    root_logger.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(log_level)
    handler.addFilter(RequestIdFilter())
    handler.addFilter(SensitiveDataFilter())

    if environment == "development":
        handler.setFormatter(TextFormatter())
    else:
        handler.setFormatter(JSONFormatter())

    root_logger.addHandler(handler)

    # Quieten noisy third-party loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

    logging.getLogger(__name__).info(
        "Logging configured — environment=%s level=%s", environment, logging.getLevelName(log_level)
    )
