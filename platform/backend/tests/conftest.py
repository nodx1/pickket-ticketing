"""Compatibility wrapper so `pytest tests/` uses the canonical app test fixtures."""

from app.tests.conftest import *  # noqa: F401,F403
from app.tests.conftest import _mock_redis as _mock_redis  # noqa: F401
from app.tests.conftest import _isolate_integration_ledger as _isolate_integration_ledger  # noqa: F401
from app.tests.conftest import _reset_rate_limiters as _reset_rate_limiters  # noqa: F401
from app.tests.conftest import _enable_kill_switched_features as _enable_kill_switched_features  # noqa: F401
