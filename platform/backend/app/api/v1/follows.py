"""MIGRATED to app.api.v1.follow.follow_routes — Phase 11 에서 제거 예정.

이 shim 은 app/api/v1/router.py 의 `from app.api.v1 import follows` 호환용.
"""
from app.api.v1.follow.follow_routes import router  # noqa: F401
