"""P2-14: AI content filtering service.

Rule-based detection for:
  - Profanity (Korean + English)
  - Spam patterns (repeated chars, excessive caps, URL spam)
  - AI-generated text heuristics (repetitive phrases, unnatural grammar)
"""

from __future__ import annotations

import re
import logging
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


# ── Result types ──────────────────────────────────────────────


class ContentAction(str, Enum):
    PASS = "pass"
    FLAG = "flag"
    BLOCK = "block"


@dataclass
class ContentCheckResult:
    is_flagged: bool
    reasons: list[str]
    confidence: float  # 0.0 ~ 1.0
    action: ContentAction
    details: dict = field(default_factory=dict)


# ── Configurable thresholds ───────────────────────────────────


@dataclass
class FilterConfig:
    # Profanity
    profanity_action: ContentAction = ContentAction.FLAG

    # Spam
    max_repeated_chars: int = 5          # e.g., "ㅋㅋㅋㅋㅋㅋ" → 6 repeated
    max_url_count: int = 3               # more than 3 URLs → spam
    excessive_caps_ratio: float = 0.7    # >70% uppercase → spam
    min_text_length_for_caps: int = 20   # only check caps for longer text
    spam_action: ContentAction = ContentAction.FLAG

    # AI-generated text
    repetitive_phrase_threshold: int = 3  # same phrase 3+ times
    min_phrase_length: int = 4            # min words in phrase to check
    ai_detection_action: ContentAction = ContentAction.FLAG

    # Overall
    block_confidence_threshold: float = 0.85
    flag_confidence_threshold: float = 0.5


DEFAULT_CONFIG = FilterConfig()

# ── Word lists ────────────────────────────────────────────────

# Korean profanity (common terms, kept minimal — extend in production)
_KO_PROFANITY: set[str] = {
    "시발", "씨발", "씨팔", "시팔", "ㅅㅂ", "ㅆㅂ",
    "병신", "ㅂㅅ", "븅신",
    "지랄", "ㅈㄹ",
    "개새끼", "개세끼", "개색끼",
    "미친놈", "미친년",
    "꺼져", "닥쳐",
    "존나", "ㅈㄴ", "졸라",
    "느금마", "니엄마",
    "ㅗ",
}

# English profanity (common terms)
_EN_PROFANITY: set[str] = {
    "fuck", "fucking", "shit", "asshole", "bitch",
    "bastard", "dick", "pussy", "cunt", "damn",
    "nigger", "nigga", "faggot", "retard",
}

# Leet-speak / evasion patterns
_LEET_MAP: dict[str, str] = {
    "@": "a", "0": "o", "1": "i", "3": "e",
    "$": "s", "!": "i", "+": "t",
}

# Spam URL pattern
_URL_PATTERN = re.compile(
    r"https?://[^\s<>\"']+|www\.[^\s<>\"']+",
    re.IGNORECASE,
)

# Repeated character pattern (3+)
_REPEATED_CHAR_PATTERN = re.compile(r"(.)\1{2,}")

# Korean repeated jamo
_REPEATED_JAMO_PATTERN = re.compile(r"([ㄱ-ㅎㅏ-ㅣ])\1{2,}")


# ── Internals ─────────────────────────────────────────────────


def _normalize_leet(text: str) -> str:
    """Normalize leet-speak to detect evasion."""
    result = text.lower()
    for leet, char in _LEET_MAP.items():
        result = result.replace(leet, char)
    # Remove non-alphanumeric separators used for evasion (e.g., "f.u.c.k")
    result = re.sub(r"(?<=\w)[.\-_*](?=\w)", "", result)
    return result


def _check_profanity(text: str) -> tuple[bool, list[str], float]:
    """Check for profanity in Korean and English."""
    reasons: list[str] = []
    normalized = _normalize_leet(text)
    words = set(re.findall(r"[\w가-힣ㄱ-ㅎㅏ-ㅣ]+", normalized))

    found_ko = words & _KO_PROFANITY
    found_en = words & _EN_PROFANITY

    # Also check substrings for compound words
    for term in _KO_PROFANITY:
        if len(term) >= 2 and term in normalized:
            found_ko.add(term)
    for term in _EN_PROFANITY:
        if len(term) >= 3 and term in normalized:
            found_en.add(term)

    if found_ko:
        reasons.append(f"한국어 비속어 감지: {', '.join(sorted(found_ko)[:3])}")
    if found_en:
        reasons.append(f"영어 비속어 감지: {', '.join(sorted(found_en)[:3])}")

    total = len(found_ko) + len(found_en)
    confidence = min(1.0, 0.5 + (total - 1) * 0.2) if total > 0 else 0.0

    return bool(reasons), reasons, confidence


def _check_spam(text: str, config: FilterConfig) -> tuple[bool, list[str], float]:
    """Check for spam patterns."""
    reasons: list[str] = []
    score = 0.0

    # Repeated characters
    for match in _REPEATED_CHAR_PATTERN.finditer(text):
        if len(match.group()) > config.max_repeated_chars:
            reasons.append(f"반복 문자 감지: '{match.group()[:10]}...'")
            score += 0.3
            break

    # Repeated jamo
    for match in _REPEATED_JAMO_PATTERN.finditer(text):
        if len(match.group()) > config.max_repeated_chars:
            reasons.append(f"반복 자모 감지: '{match.group()[:10]}...'")
            score += 0.2
            break

    # URL spam
    urls = _URL_PATTERN.findall(text)
    if len(urls) > config.max_url_count:
        reasons.append(f"URL 스팸 감지: {len(urls)}개 URL 포함")
        score += 0.4

    # Excessive caps (English text only)
    alpha_chars = [c for c in text if c.isalpha() and ord(c) < 128]
    if len(alpha_chars) >= config.min_text_length_for_caps:
        upper_ratio = sum(1 for c in alpha_chars if c.isupper()) / len(alpha_chars)
        if upper_ratio > config.excessive_caps_ratio:
            reasons.append(f"과도한 대문자 사용: {upper_ratio:.0%}")
            score += 0.3

    confidence = min(1.0, score)
    return bool(reasons), reasons, confidence


def _check_ai_generated(text: str, config: FilterConfig) -> tuple[bool, list[str], float]:
    """Heuristic detection of AI-generated text.

    Checks:
      1. Repetitive phrases (same n-gram appears 3+ times)
      2. Unnaturally uniform sentence length
      3. Overuse of transitional phrases
    """
    reasons: list[str] = []
    score = 0.0

    words = text.split()
    if len(words) < 20:
        # Too short for meaningful AI detection
        return False, [], 0.0

    # 1. Repetitive n-grams (4-word phrases)
    ngram_size = config.min_phrase_length
    ngrams: dict[str, int] = {}
    for i in range(len(words) - ngram_size + 1):
        gram = " ".join(words[i : i + ngram_size]).lower()
        ngrams[gram] = ngrams.get(gram, 0) + 1

    repeated = {k: v for k, v in ngrams.items() if v >= config.repetitive_phrase_threshold}
    if repeated:
        top = sorted(repeated.items(), key=lambda x: -x[1])[:2]
        reasons.append(
            f"반복 구문 감지: " + ", ".join(f"'{k}'({v}회)" for k, v in top)
        )
        score += 0.4

    # 2. Sentence length uniformity (AI tends to write uniform-length sentences)
    sentences = re.split(r"[.!?。]+", text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 5]
    if len(sentences) >= 5:
        lengths = [len(s.split()) for s in sentences]
        avg = sum(lengths) / len(lengths)
        if avg > 0:
            variance = sum((l - avg) ** 2 for l in lengths) / len(lengths)
            cv = (variance ** 0.5) / avg  # coefficient of variation
            if cv < 0.15:  # very uniform
                reasons.append(f"문장 길이 균일성 이상: CV={cv:.2f}")
                score += 0.3

    # 3. Overuse of transitional/filler phrases
    _transitions_ko = [
        "또한", "더불어", "뿐만 아니라", "이와 같이", "따라서",
        "그러므로", "결론적으로", "마지막으로", "첫째", "둘째",
    ]
    _transitions_en = [
        "furthermore", "moreover", "in addition", "consequently",
        "therefore", "in conclusion", "firstly", "secondly",
        "it is important to note", "it should be noted",
    ]
    text_lower = text.lower()
    transition_count = sum(1 for t in _transitions_ko + _transitions_en if t in text_lower)
    sentence_count = max(len(sentences), 1)
    if transition_count / sentence_count > 0.5 and transition_count >= 4:
        reasons.append(f"과도한 접속사/전환어 사용: {transition_count}개")
        score += 0.3

    confidence = min(1.0, score)
    return bool(reasons), reasons, confidence


# ── Public API ────────────────────────────────────────────────


def check_content(text: str, *, config: FilterConfig | None = None) -> ContentCheckResult:
    """Analyze text content for profanity, spam, and AI-generation indicators.

    Args:
        text: The content to check.
        config: Optional filter configuration (uses defaults if None).

    Returns:
        ContentCheckResult with flagging details.
    """
    if not text or not text.strip():
        return ContentCheckResult(
            is_flagged=False,
            reasons=[],
            confidence=0.0,
            action=ContentAction.PASS,
        )

    cfg = config or DEFAULT_CONFIG
    all_reasons: list[str] = []
    max_confidence = 0.0
    details: dict = {}

    # Run all checks
    profanity_hit, profanity_reasons, profanity_conf = _check_profanity(text)
    if profanity_hit:
        all_reasons.extend(profanity_reasons)
        max_confidence = max(max_confidence, profanity_conf)
        details["profanity"] = {"confidence": profanity_conf, "reasons": profanity_reasons}

    spam_hit, spam_reasons, spam_conf = _check_spam(text, cfg)
    if spam_hit:
        all_reasons.extend(spam_reasons)
        max_confidence = max(max_confidence, spam_conf)
        details["spam"] = {"confidence": spam_conf, "reasons": spam_reasons}

    ai_hit, ai_reasons, ai_conf = _check_ai_generated(text, cfg)
    if ai_hit:
        all_reasons.extend(ai_reasons)
        max_confidence = max(max_confidence, ai_conf)
        details["ai_generated"] = {"confidence": ai_conf, "reasons": ai_reasons}

    # Determine action
    if not all_reasons:
        action = ContentAction.PASS
    elif max_confidence >= cfg.block_confidence_threshold:
        action = ContentAction.BLOCK
    elif max_confidence >= cfg.flag_confidence_threshold:
        action = ContentAction.FLAG
    else:
        action = ContentAction.PASS

    is_flagged = action in (ContentAction.FLAG, ContentAction.BLOCK)

    if is_flagged:
        logger.info(
            "Content flagged: action=%s confidence=%.2f reasons=%s",
            action.value,
            max_confidence,
            all_reasons[:3],
        )

    return ContentCheckResult(
        is_flagged=is_flagged,
        reasons=all_reasons,
        confidence=round(max_confidence, 3),
        action=action,
        details=details,
    )
