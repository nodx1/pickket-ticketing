"""Centralized exception handlers for the FastAPI application."""

import logging
import traceback

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse

from app.core.exceptions import AppError

logger = logging.getLogger(__name__)


def _get_request_id() -> str:
    try:
        from app.middleware.request_id import request_id_var
        return request_id_var.get("")
    except Exception:
        return ""


def _report_to_sentry(exc: Exception, request: Request) -> None:
    try:
        import sentry_sdk
        if sentry_sdk.is_initialized():
            with sentry_sdk.push_scope() as scope:
                scope.set_tag("request_id", _get_request_id())
                scope.set_tag("path", request.url.path)
                scope.set_tag("method", request.method)
                sentry_sdk.capture_exception(exc)
    except Exception:
        pass


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    request_id = _get_request_id()
    logger.warning(
        "AppError: code=%s status=%d path=%s request_id=%s",
        exc.code,
        exc.status_code,
        request.url.path,
        request_id,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.message,
            "code": exc.code,
            "request_id": request_id,
        },
    )


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    request_id = _get_request_id()
    detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": detail,
            "code": "HTTP_ERROR",
            "request_id": request_id,
        },
        headers=getattr(exc, "headers", None),
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    request_id = _get_request_id()
    logger.error(
        "Unhandled exception: path=%s method=%s request_id=%s\n%s",
        request.url.path,
        request.method,
        request_id,
        traceback.format_exc(),
    )
    _report_to_sentry(exc, request)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "서버 오류가 발생했습니다.",
            "code": "INTERNAL_ERROR",
            "request_id": request_id,
        },
    )


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
