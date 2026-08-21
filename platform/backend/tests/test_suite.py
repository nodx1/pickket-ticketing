"""Collect canonical backend tests when invoked as `pytest tests/`."""

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture(autouse=True)
def _enable_waitlist_flag():
    """Enable face-value waitlist feature flag for waitlist tests."""
    with patch(
        "app.api.v1.waitlist.get_feature_flag",
        new_callable=AsyncMock,
        return_value=True,
    ):
        yield


from app.tests.test_allocations import *  # noqa: F401,F403,E402
from app.tests.test_auth import *  # noqa: F401,F403
from app.tests.test_bids import *  # noqa: F401,F403
from app.tests.test_engine_integration import *  # noqa: F401,F403
from app.tests.test_events import *  # noqa: F401,F403
from app.tests.test_lottery_flow import *  # noqa: F401,F403
from app.tests.test_lottery_verification import *  # noqa: F401,F403
from app.tests.test_orders_api import *  # noqa: F401,F403
from app.tests.test_purchase import *  # noqa: F401,F403
from app.tests.test_resale import *  # noqa: F401,F403
from app.tests.test_security_config import *  # noqa: F401,F403
from app.tests.test_search import *  # noqa: F401,F403
from app.tests.test_tickets_api import *  # noqa: F401,F403
from app.tests.test_tiers import *  # noqa: F401,F403
from app.tests.test_waitlist_flow import *  # noqa: F401,F403
