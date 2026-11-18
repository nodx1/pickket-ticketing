"""go 행사 유형(24종) → v2 category 매핑이 go 쪽 표와 같아야 한다.

심사 요청(review-requested) 동기화가 이 표로 category 를 다시 계산하므로, 빠진 유형은
기본값 concert 로 바뀌어 피켓 마켓에 잘못 노출된다(스포츠 골프 행사 → 「콘서트」).
"""

from app.api.v1.internal_sync import GO_EVENT_TYPE_TO_V2_CATEGORY

GO_EVENT_TYPES = [
    "concert", "festival", "conference", "exhibition", "mice", "workshop", "fan_meeting", "flea_market",
    "lecture", "preview", "local_festival", "party", "networking", "sports", "musical", "theater",
    "comedy", "seminar", "meetup", "webinar", "trade_show", "charity", "awards", "screening",
]


def test_all_go_event_types_are_mapped():
    missing = [t for t in GO_EVENT_TYPES if t not in GO_EVENT_TYPE_TO_V2_CATEGORY]
    assert missing == []


def test_sports_stays_sports():
    assert GO_EVENT_TYPE_TO_V2_CATEGORY["sports"] == "sports"
    assert GO_EVENT_TYPE_TO_V2_CATEGORY["musical"] == "musical"
