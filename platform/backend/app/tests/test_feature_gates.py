"""Tests for feature gates — ensure_sale_mode_enabled validates supported modes."""

import pytest
from fastapi import HTTPException
from unittest.mock import AsyncMock, patch

from app.core.feature_gate import ensure_sale_mode_enabled
from app.models.point import point_tx_type_enum, point_type_enum


def test_point_enum_bind_values_match_db_enum_values():
    assert list(point_type_enum.enums) == ["fan", "social"]
    assert "earn_signup" in point_tx_type_enum.enums


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_fixed_fcfs():
    """fixed_fcfs should always be accepted."""
    await ensure_sale_mode_enabled("fixed_fcfs")  # no exception


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_point_lottery():
    """point_lottery should always be accepted."""
    await ensure_sale_mode_enabled("point_lottery")  # no exception


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_queue():
    """queue should always be accepted."""
    await ensure_sale_mode_enabled("queue")  # no exception


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_fanclub_presale_when_enabled():
    """fanclub_presale should be accepted when feature flag is enabled."""
    with patch(
        "app.core.feature_flags.get_feature_flag",
        new_callable=AsyncMock,
        return_value=True,
    ):
        await ensure_sale_mode_enabled("fanclub_presale")  # no exception


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_fanclub_presale_when_disabled():
    """fanclub_presale should be rejected when feature flag is disabled."""
    with patch(
        "app.core.feature_flags.get_feature_flag",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await ensure_sale_mode_enabled("fanclub_presale")
        assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_rejects_vcg_auction():
    """vcg_auction is no longer a valid sale mode."""
    with pytest.raises(HTTPException) as exc_info:
        await ensure_sale_mode_enabled("vcg_auction")
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_rejects_dutch_auction():
    """dutch_auction is no longer a valid sale mode."""
    with pytest.raises(HTTPException) as exc_info:
        await ensure_sale_mode_enabled("dutch_auction")
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_rejects_fixed_lottery():
    """fixed_lottery is no longer a valid sale mode."""
    with pytest.raises(HTTPException) as exc_info:
        await ensure_sale_mode_enabled("fixed_lottery")
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_ensure_sale_mode_enabled_rejects_unknown():
    """Unknown sale mode should be rejected."""
    with pytest.raises(HTTPException) as exc_info:
        await ensure_sale_mode_enabled("mystery_mode")
    assert exc_info.value.status_code == 400
