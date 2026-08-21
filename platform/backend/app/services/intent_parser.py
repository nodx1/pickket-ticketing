"""자연어 검색 의도 파서 — 규칙 기반 우선, LLM 폴백.

사용자의 자연어 쿼리에서 날짜, 위치, 카테고리, 가격, 아티스트 등
구조화된 검색 필터를 추출합니다.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.core.config import settings
from app.core.http_client import traced_headers

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))


# ── 파싱 결과 ─────────────────────────────────────────────────────────────────

@dataclass
class ParsedIntent:
    """자연어 쿼리에서 추출된 구조화 필터."""

    date_from: datetime | None = None
    date_to: datetime | None = None
    location: str | None = None
    category: str | None = None
    budget_max: float | None = None
    artist_name: str | None = None
    keywords: list[str] = field(default_factory=list)
    confidence: float = 0.0
    source: str = "rule"  # "rule" | "llm"

    def to_dict(self) -> dict[str, Any]:
        return {
            "date_from": self.date_from.isoformat() if self.date_from else None,
            "date_to": self.date_to.isoformat() if self.date_to else None,
            "location": self.location,
            "category": self.category,
            "budget_max": self.budget_max,
            "artist_name": self.artist_name,
            "keywords": self.keywords,
            "confidence": self.confidence,
            "source": self.source,
        }


# ── 카테고리 매핑 ─────────────────────────────────────────────────────────────

CATEGORY_MAP: dict[str, str] = {
    # 콘서트
    "콘서트": "CONCERT",
    "콘서": "CONCERT",
    "공연": "CONCERT",
    "라이브": "CONCERT",
    "페스": "FESTIVAL",
    # 뮤지컬
    "뮤지컬": "MUSICAL",
    # 스포츠
    "스포츠": "SPORTS",
    "축구": "SPORTS",
    "야구": "SPORTS",
    "농구": "SPORTS",
    "배구": "SPORTS",
    "경기": "SPORTS",
    # 축제
    "축제": "FESTIVAL",
    "페스티벌": "FESTIVAL",
    # 클래식
    "클래식": "CLASSICAL",
    "오케스트라": "CLASSICAL",
    "오페라": "CLASSICAL",
    "리사이틀": "CLASSICAL",
    # e스포츠
    "e스포츠": "ESPORTS",
    "이스포츠": "ESPORTS",
    "롤": "ESPORTS",
    "lol": "ESPORTS",
    "게임 대회": "ESPORTS",
    # 전시
    "전시": "EXHIBITION",
    "전시회": "EXHIBITION",
    "미술": "EXHIBITION",
    "갤러리": "EXHIBITION",
}

# ── 도시 매핑 ──────────────────────────────────────────────────────────────────

CITY_ALIASES: dict[str, str] = {
    "서울": "서울",
    "부산": "부산",
    "대구": "대구",
    "인천": "인천",
    "광주": "광주",
    "대전": "대전",
    "울산": "울산",
    "세종": "세종",
    "수원": "수원",
    "고양": "고양",
    "용인": "용인",
    "성남": "성남",
    "제주": "제주",
    "창원": "창원",
    "전주": "전주",
    "청주": "청주",
    "천안": "천안",
    "안양": "안양",
    "김포": "김포",
    "포항": "포항",
    "춘천": "춘천",
    "경주": "경주",
    "여수": "여수",
    "강릉": "강릉",
    "속초": "속초",
    "목포": "목포",
    "안산": "안산",
    "평택": "평택",
    "파주": "파주",
    "화성": "화성",
    # 영어 → 한국어
    "seoul": "서울",
    "busan": "부산",
    "daegu": "대구",
    "incheon": "인천",
    "gwangju": "광주",
    "daejeon": "대전",
    "ulsan": "울산",
    "jeju": "제주",
}


# ── 날짜 파싱 ──────────────────────────────────────────────────────────────────

def _now_kst() -> datetime:
    return datetime.now(KST)


def _parse_date_expressions(text: str) -> tuple[datetime | None, datetime | None]:
    """한국어 날짜 표현을 (date_from, date_to)로 변환."""
    now = _now_kst()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # "오늘"
    if re.search(r"오늘", text):
        return today_start, today_start + timedelta(days=1)

    # "내일"
    if re.search(r"내일", text):
        tomorrow = today_start + timedelta(days=1)
        return tomorrow, tomorrow + timedelta(days=1)

    # "모레" / "글피"
    if re.search(r"모레", text):
        d = today_start + timedelta(days=2)
        return d, d + timedelta(days=1)
    if re.search(r"글피", text):
        d = today_start + timedelta(days=3)
        return d, d + timedelta(days=1)

    # "이번 주" / "이번주"
    if re.search(r"이번\s*주", text):
        weekday = now.weekday()  # Mon=0
        week_start = today_start - timedelta(days=weekday)
        week_end = week_start + timedelta(days=7)
        return week_start, week_end

    # "다음 주" / "다음주"
    if re.search(r"다음\s*주", text):
        weekday = now.weekday()
        next_mon = today_start + timedelta(days=7 - weekday)
        return next_mon, next_mon + timedelta(days=7)

    # "이번 주말" / "이번주말" / "주말"
    if re.search(r"(이번\s*)?주말", text):
        weekday = now.weekday()
        days_to_sat = (5 - weekday) % 7
        if days_to_sat == 0 and weekday != 5:
            days_to_sat = 7
        saturday = today_start + timedelta(days=days_to_sat)
        monday = saturday + timedelta(days=2)
        return saturday, monday

    # "이번 달" / "이번달"
    if re.search(r"이번\s*달", text):
        month_start = today_start.replace(day=1)
        if now.month == 12:
            month_end = month_start.replace(year=now.year + 1, month=1)
        else:
            month_end = month_start.replace(month=now.month + 1)
        return month_start, month_end

    # "다음 달" / "다음달"
    if re.search(r"다음\s*달", text):
        if now.month == 12:
            next_month_start = today_start.replace(year=now.year + 1, month=1, day=1)
        else:
            next_month_start = today_start.replace(month=now.month + 1, day=1)
        if next_month_start.month == 12:
            next_month_end = next_month_start.replace(year=next_month_start.year + 1, month=1)
        else:
            next_month_end = next_month_start.replace(month=next_month_start.month + 1)
        return next_month_start, next_month_end

    # "N월" (특정 월)
    m = re.search(r"(\d{1,2})\s*월", text)
    if m:
        month = int(m.group(1))
        if 1 <= month <= 12:
            year = now.year
            # 이미 지난 달이면 내년으로
            if month < now.month:
                year += 1
            month_start = today_start.replace(year=year, month=month, day=1)
            if month == 12:
                month_end = month_start.replace(year=year + 1, month=1)
            else:
                month_end = month_start.replace(month=month + 1)
            return month_start, month_end

    # "N월 D일"
    m = re.search(r"(\d{1,2})\s*월\s*(\d{1,2})\s*일", text)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        if 1 <= month <= 12 and 1 <= day <= 31:
            year = now.year
            try:
                target = today_start.replace(year=year, month=month, day=day)
                if target < today_start:
                    target = target.replace(year=year + 1)
                return target, target + timedelta(days=1)
            except ValueError:
                pass

    return None, None


# ── 가격 파싱 ──────────────────────────────────────────────────────────────────

def _parse_price(text: str) -> float | None:
    """한국어 가격 표현을 float(원)로 변환."""
    # "N만원 이하", "N만원대", "N만원 미만"
    m = re.search(r"(\d+(?:\.\d+)?)\s*만\s*원?\s*(이하|미만|이내|대|까지)?", text)
    if m:
        return float(m.group(1)) * 10000

    # "N원 이하"
    m = re.search(r"(\d{1,3}(?:,?\d{3})*)\s*원\s*(이하|미만|이내|까지)?", text)
    if m:
        price_str = m.group(1).replace(",", "")
        return float(price_str)

    # "무료", "공짜"
    if re.search(r"무료|공짜|0원", text):
        return 0.0

    return None


# ── 규칙 기반 파서 ─────────────────────────────────────────────────────────────

def parse_intent_rules(query: str, budget_max: float | None = None) -> ParsedIntent:
    """규칙 기반으로 자연어 쿼리를 구조화된 검색 의도로 파싱."""
    result = ParsedIntent()
    text = query.strip()
    text_lower = text.lower()
    matched_fields = 0

    # 1. 날짜 추출
    date_from, date_to = _parse_date_expressions(text)
    if date_from:
        result.date_from = date_from
        result.date_to = date_to
        matched_fields += 1

    # 2. 위치 추출
    for alias, city in CITY_ALIASES.items():
        if alias in text_lower:
            result.location = city
            matched_fields += 1
            break

    # 3. 카테고리 추출
    for keyword, category in CATEGORY_MAP.items():
        if keyword in text_lower:
            result.category = category
            matched_fields += 1
            break

    # 4. 가격 추출
    price = _parse_price(text)
    if price is not None:
        result.budget_max = price
        matched_fields += 1
    elif budget_max is not None:
        result.budget_max = budget_max
        matched_fields += 1

    # 5. 키워드 추출 (날짜/위치/카테고리/가격 표현 제거 후 남은 의미있는 단어)
    keywords = _extract_keywords(text)
    if keywords:
        result.keywords = keywords
        # 키워드가 아티스트명일 수 있음 — artist_name에도 설정
        if len(keywords) >= 1:
            # 조사 붙은 단어 제거, 2글자 이상만
            potential_artist = [k for k in keywords if len(k) >= 2]
            if potential_artist:
                result.artist_name = potential_artist[0]

    # 신뢰도 계산
    if matched_fields == 0 and not keywords:
        result.confidence = 0.1
    elif matched_fields == 0:
        result.confidence = 0.3
    elif matched_fields == 1:
        result.confidence = 0.5
    elif matched_fields == 2:
        result.confidence = 0.7
    else:
        result.confidence = 0.8 + min(matched_fields - 3, 2) * 0.05

    result.confidence = min(result.confidence, 1.0)
    result.source = "rule"
    return result


def _extract_keywords(text: str) -> list[str]:
    """검색에 사용할 키워드 추출 — 불용어/문법어 제거."""
    # 날짜, 위치, 카테고리, 가격 관련 패턴 제거
    cleaned = text
    # 날짜 표현 제거
    date_patterns = [
        r"오늘", r"내일", r"모레", r"글피",
        r"이번\s*주말?", r"다음\s*주말?",
        r"이번\s*달", r"다음\s*달",
        r"\d{1,2}\s*월\s*(\d{1,2}\s*일)?",
    ]
    for pat in date_patterns:
        cleaned = re.sub(pat, "", cleaned)

    # 도시명 제거
    for alias in CITY_ALIASES:
        cleaned = re.sub(re.escape(alias), "", cleaned, flags=re.IGNORECASE)

    # 카테고리명 제거
    for keyword in CATEGORY_MAP:
        cleaned = re.sub(re.escape(keyword), "", cleaned, flags=re.IGNORECASE)

    # 가격 표현 제거
    cleaned = re.sub(r"\d+(?:\.\d+)?\s*만\s*원?\s*(이하|미만|이내|대|까지)?", "", cleaned)
    cleaned = re.sub(r"\d{1,3}(?:,?\d{3})*\s*원\s*(이하|미만|이내|까지)?", "", cleaned)
    cleaned = re.sub(r"무료|공짜|0원", "", cleaned)

    # 불용어 제거
    stopwords = {
        "에서", "에", "을", "를", "이", "가", "은", "는", "의", "도", "로", "으로",
        "과", "와", "하고", "이랑", "랑", "한", "할", "하는", "있는", "없는",
        "보고", "보러", "가고", "갈", "싶어", "싶은", "싶다", "좋겠",
        "뭐", "뭘", "어떤", "어디", "언제", "있나", "있어", "해줘", "알려줘",
        "추천", "추천해", "찾아", "찾아줘", "검색", "보여줘",
        "이하", "미만", "이내", "까지", "정도", "대",
    }

    # 한국어/영어 토큰 분리 (공백 + 조사 경계)
    tokens = re.split(r"\s+", cleaned.strip())
    result = []
    for token in tokens:
        token = token.strip()
        if not token or len(token) < 2:
            continue
        if token in stopwords:
            continue
        # 조사 떼기 (간단 규칙)
        for suffix in ["에서", "에서는", "에는", "에도", "에서도", "에", "을", "를", "이", "가", "은", "는", "도"]:
            if token.endswith(suffix) and len(token) > len(suffix) + 1:
                token = token[: -len(suffix)]
                break
        if token and len(token) >= 2 and token not in stopwords:
            result.append(token)

    return result


# ── LLM 폴백 파서 ──────────────────────────────────────────────────────────────

_LLM_PARSE_PROMPT = """사용자의 이벤트/공연 검색 쿼리를 분석하여 아래 JSON 형식으로 반환하세요.
필드가 없으면 null로 설정하세요.

{
  "date_from": "YYYY-MM-DD" or null,
  "date_to": "YYYY-MM-DD" or null,
  "location": "도시명 (한국어)" or null,
  "category": "CONCERT|MUSICAL|SPORTS|FESTIVAL|CLASSICAL|ESPORTS|EXHIBITION" or null,
  "budget_max": number(원) or null,
  "artist_name": "아티스트/팀명" or null,
  "keywords": ["키워드1", "키워드2"]
}

오늘 날짜: {today}
쿼리: {query}"""


async def parse_intent_llm(query: str, budget_max: float | None = None) -> ParsedIntent:
    """LLM을 사용하여 자연어 쿼리를 구조화된 검색 의도로 파싱."""
    if not settings.CHATBOT_LLM_API_URL:
        raise RuntimeError("LLM not configured")

    today = _now_kst().strftime("%Y-%m-%d")
    prompt = _LLM_PARSE_PROMPT.format(today=today, query=query)

    payload = {
        "model": settings.CHATBOT_LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 300,
        "temperature": 0.1,
    }

    headers: dict[str, str] = traced_headers({"Content-Type": "application/json"})
    if settings.CHATBOT_LLM_API_KEY:
        headers["Authorization"] = f"Bearer {settings.CHATBOT_LLM_API_KEY}"

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{settings.CHATBOT_LLM_API_URL}/chat/completions",
            json=payload,
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()

    content = data["choices"][0]["message"]["content"]

    # JSON 블록 추출
    json_match = re.search(r"\{[\s\S]*\}", content)
    if not json_match:
        raise ValueError("LLM response does not contain valid JSON")

    parsed = json.loads(json_match.group())

    result = ParsedIntent(source="llm", confidence=0.8)

    if parsed.get("date_from"):
        try:
            result.date_from = datetime.fromisoformat(parsed["date_from"]).replace(tzinfo=KST)
        except (ValueError, TypeError):
            pass

    if parsed.get("date_to"):
        try:
            result.date_to = datetime.fromisoformat(parsed["date_to"]).replace(tzinfo=KST)
        except (ValueError, TypeError):
            pass

    if parsed.get("location"):
        result.location = parsed["location"]

    if parsed.get("category"):
        cat = parsed["category"].upper()
        valid_cats = {"CONCERT", "MUSICAL", "SPORTS", "FESTIVAL", "CLASSICAL", "ESPORTS", "EXHIBITION"}
        if cat in valid_cats:
            result.category = cat

    if parsed.get("budget_max") is not None:
        try:
            result.budget_max = float(parsed["budget_max"])
        except (ValueError, TypeError):
            pass

    if budget_max is not None and result.budget_max is None:
        result.budget_max = budget_max

    if parsed.get("artist_name"):
        result.artist_name = parsed["artist_name"]

    if parsed.get("keywords"):
        result.keywords = [str(k) for k in parsed["keywords"] if k]

    return result


# ── 통합 파서 ──────────────────────────────────────────────────────────────────

async def parse_intent(
    query: str,
    budget_max: float | None = None,
    known_artists: list[str] | None = None,
) -> ParsedIntent:
    """규칙 기반 파싱 → 신뢰도 낮으면 LLM 폴백.

    Args:
        query: 사용자 자연어 검색 쿼리
        budget_max: 요청에서 별도 전달된 예산 상한
        known_artists: DB에서 조회한 아티스트 이름 목록 (매칭용)
    """
    # 1) 규칙 기반 파싱
    result = parse_intent_rules(query, budget_max)

    # 2) 알려진 아티스트명 매칭
    if known_artists:
        text_lower = query.lower()
        for artist in known_artists:
            if artist.lower() in text_lower:
                result.artist_name = artist
                result.confidence = min(result.confidence + 0.15, 1.0)
                break

    # 3) 신뢰도 낮고 LLM 설정되어 있으면 LLM 폴백
    if result.confidence < 0.5 and settings.CHATBOT_LLM_API_URL:
        try:
            llm_result = await parse_intent_llm(query, budget_max)
            # LLM 결과가 더 풍부하면 사용
            llm_fields = sum([
                llm_result.date_from is not None,
                llm_result.location is not None,
                llm_result.category is not None,
                llm_result.budget_max is not None,
                llm_result.artist_name is not None,
            ])
            rule_fields = sum([
                result.date_from is not None,
                result.location is not None,
                result.category is not None,
                result.budget_max is not None,
                result.artist_name is not None,
            ])
            if llm_fields > rule_fields:
                return llm_result
        except Exception as e:
            logger.warning("LLM intent parsing failed, using rule-based: %s", e)

    return result
