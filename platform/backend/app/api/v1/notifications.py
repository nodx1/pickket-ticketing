"""MIGRATED to app.api.v1.notification.notification_routes — Phase 11 에서 제거 예정.

이 shim 은 app/api/v1/router.py 의 `from app.api.v1 import notifications` 호환용.
일부 테스트가 _get_sse_user / _stream_token_key 같은 private 식별자를 직접 import
하므로 dependencies 모듈에서 함께 re-export.
"""
from app.api.v1.notification.dependencies import (  # noqa: F401
    _get_sse_user,
    _stream_token_key,
)
from app.api.v1.notification.notification_routes import router  # noqa: F401
