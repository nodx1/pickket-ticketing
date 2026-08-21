"""좌석 배치도 원본(seat_map_data) 소비자 격리 유틸 — 레벨2 3차 3.1.

draft 계약(3.1): 빌더가 draft 맵도 events.seat_map_data 에 담는다(go DROP 대비). 그러나 소비자
(마켓 상세·화이트라벨 랜딩)는 **published 맵만** 렌더해야 한다 — draft(미발행 편집본) 공개 누출 0.

이 함수는 모든 소비자 read 경계에서 seat_map_data.maps 를 status=='published' 로 필터한다.
published 맵이 없으면 None 반환(배치도 없음 = 소비자는 seat_map_url 폴백).
"""
from __future__ import annotations

from typing import Any


def published_seat_map_data(value: Any) -> dict | None:
    """seat_map_data 에서 published 맵만 남긴 사본 반환(소비자 격리).

    - value 가 dict 아니거나 maps 가 list 아니면 None.
    - maps[].status != 'published' 인 원소 제거. 남은 맵이 없으면 None.
    - 원본을 변형하지 않는다(얕은 사본 + 필터된 maps 리스트).
    """
    if not isinstance(value, dict):
        return None
    maps = value.get("maps")
    if not isinstance(maps, list):
        return None
    published = [
        m
        for m in maps
        if isinstance(m, dict) and m.get("status") == "published"
    ]
    if not published:
        return None
    out = dict(value)
    out["maps"] = published
    return out
