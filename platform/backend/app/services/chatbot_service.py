"""2-Tier 챗봇 서비스 — Tier 0 (키워드 FAQ) + Tier 1 (LLM + 도구 호출).

Tier 0: 패턴 매칭 기반 FAQ 응답 (무료, 빠름)
Tier 1: OpenAI-compatible LLM (RAG + 내부 API 도구)
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.http_client import traced_headers
from app.core.redis import get_redis, v2_key
from app.models.event import Event, SeatTier
from app.models.order import Order
from app.models.ticket import Ticket

logger = logging.getLogger(__name__)


# ── Tier 0: FAQ 데이터베이스 ─────────────────────────────────────────────────

@dataclass
class FAQEntry:
    keywords: list[str]
    question: str
    answer: str
    category: str


FAQ_DATABASE: list[FAQEntry] = [
    # 환불
    FAQEntry(
        keywords=["환불", "환불하고", "돈 돌려", "환불 방법", "취소하고 싶", "환불해"],
        question="환불은 어떻게 하나요?",
        answer="환불은 마이페이지 > 주문내역에서 신청할 수 있습니다. 이벤트 시작 7일 전까지는 전액 환불이 가능하며, 7일 이내에는 환불 수수료가 부과될 수 있습니다. 자세한 환불 정책은 환불정책 페이지를 참고해주세요.",
        category="환불",
    ),
    FAQEntry(
        keywords=["환불 기간", "환불 언제", "환불 며칠"],
        question="환불 처리 기간은 얼마나 걸리나요?",
        answer="환불 신청 후 영업일 기준 3~5일 이내에 처리됩니다. 결제 수단에 따라 환불 반영까지 추가 시일이 소요될 수 있습니다.",
        category="환불",
    ),
    # 결제
    FAQEntry(
        keywords=["결제", "결제 방법", "카드", "계좌이체", "결제수단"],
        question="어떤 결제 수단을 지원하나요?",
        answer="신용카드, 체크카드, 계좌이체, 간편결제(카카오페이, 네이버페이, 토스페이)를 지원합니다.",
        category="결제",
    ),
    FAQEntry(
        keywords=["결제 실패", "결제가 안", "결제 오류", "결제 에러"],
        question="결제가 실패했어요.",
        answer="결제 실패 시 다음을 확인해주세요: 1) 카드 한도 초과 여부, 2) 올바른 카드 정보 입력 여부, 3) 팝업 차단 해제 여부. 계속 문제가 발생하면 다른 결제 수단을 시도하거나 고객센터에 문의해주세요.",
        category="결제",
    ),
    FAQEntry(
        keywords=["결제 확인", "결제 완료", "결제됐나", "결제 됐는지"],
        question="결제가 완료되었는지 확인하고 싶어요.",
        answer="마이페이지 > 주문내역에서 결제 상태를 확인할 수 있습니다. '결제 완료' 상태라면 정상적으로 처리된 것입니다.",
        category="결제",
    ),
    # 취소
    FAQEntry(
        keywords=["취소", "주문 취소", "예매 취소", "취소하려면"],
        question="주문을 취소하고 싶어요.",
        answer="마이페이지 > 주문내역에서 '주문 취소' 버튼을 통해 취소할 수 있습니다. 이벤트 시작 전 취소 가능 기간 내에만 취소가 가능합니다.",
        category="취소",
    ),
    # AP (공정가격배분)
    FAQEntry(
        keywords=["AP", "공정가격", "공정가격배분", "가격 배분", "경매", "입찰"],
        question="AP(공정가격배분)이 뭔가요?",
        answer="AP(Auction Price, 공정가격배분)은 VCG 메커니즘 기반의 공정한 가격 결정 방식입니다. 모든 참여자가 자신의 진정한 가치를 입찰하도록 유도하며, 최종 가격은 차순위 입찰가를 기준으로 결정됩니다. 이를 통해 암표 없이 공정한 티켓 배분이 이루어집니다.",
        category="AP",
    ),
    FAQEntry(
        keywords=["입찰 방법", "어떻게 입찰", "입찰하려면"],
        question="입찰은 어떻게 하나요?",
        answer="이벤트 상세 페이지에서 원하는 좌석 등급을 선택한 후, 희망 가격과 수량을 입력하여 입찰합니다. 입찰 기간 종료 후 VCG 메커니즘에 따라 공정하게 배분됩니다.",
        category="AP",
    ),
    # FCFS (선착순)
    FAQEntry(
        keywords=["FCFS", "선착순", "선착", "먼저 오면"],
        question="선착순 판매는 어떻게 진행되나요?",
        answer="선착순(FCFS) 판매는 정해진 시간에 티켓이 오픈되며, 먼저 결제를 완료한 순서대로 티켓이 배정됩니다. 대기열 시스템을 통해 공정한 접근을 보장합니다.",
        category="FCFS",
    ),
    # 팬가중치
    FAQEntry(
        keywords=["팬가중치", "팬 가중치", "팬 점수", "팬 우대", "진성팬"],
        question="팬가중치란 무엇인가요?",
        answer="팬가중치는 아티스트/팀에 대한 팬 활동을 정량화한 점수입니다. 팬클럽 가입, 이벤트 참석, 커뮤니티 활동 등이 반영되며, AP(경매) 배분 시 가중치로 적용되어 진성팬에게 더 높은 티켓 획득 확률을 제공합니다.",
        category="팬가중치",
    ),
    # 양도
    FAQEntry(
        keywords=["양도", "티켓 양도", "이름 변경", "명의 변경"],
        question="티켓을 다른 사람에게 양도할 수 있나요?",
        answer="이벤트 주최자가 양도를 허용한 경우, 마이페이지 > 티켓에서 양도 신청이 가능합니다. 양도 시 수수료가 부과될 수 있으며, 양도 가능 기간은 이벤트마다 다릅니다.",
        category="양도",
    ),
    # 배송
    FAQEntry(
        keywords=["배송", "실물 티켓", "우편", "택배"],
        question="실물 티켓 배송은 어떻게 되나요?",
        answer="실물 티켓이 필요한 이벤트의 경우, 결제 완료 후 등록된 주소로 배송됩니다. 배송은 보통 결제 후 5~7일 소요되며, 이벤트 3일 전까지 도착하도록 발송됩니다.",
        category="배송",
    ),
    # 계정
    FAQEntry(
        keywords=["회원가입", "가입", "계정 만들", "계정 생성"],
        question="회원가입은 어떻게 하나요?",
        answer="피켓 앱 또는 웹사이트에서 이메일 가입 또는 소셜 로그인(카카오, 네이버, 구글)으로 간편하게 회원가입할 수 있습니다.",
        category="계정",
    ),
    FAQEntry(
        keywords=["탈퇴", "회원탈퇴", "계정 삭제", "계정 탈퇴"],
        question="회원 탈퇴하고 싶어요.",
        answer="마이페이지 > 설정 > 계정 관리에서 회원 탈퇴를 진행할 수 있습니다. 미완료 주문이나 미사용 티켓이 있는 경우 탈퇴가 제한될 수 있습니다.",
        category="계정",
    ),
    # 비밀번호
    FAQEntry(
        keywords=["비밀번호", "비번", "암호", "비밀번호 변경", "비밀번호 찾기", "비밀번호 잊어"],
        question="비밀번호를 잊어버렸어요.",
        answer="로그인 화면에서 '비밀번호 찾기'를 클릭하면 가입 시 사용한 이메일로 비밀번호 재설정 링크가 발송됩니다.",
        category="비밀번호",
    ),
    # 대기열
    FAQEntry(
        keywords=["대기열", "대기", "줄서기", "대기 순서"],
        question="대기열은 어떻게 작동하나요?",
        answer="인기 이벤트의 경우 대기열 시스템이 적용됩니다. 오픈 시간에 접속하면 랜덤으로 대기 순서가 배정되며, 차례가 되면 자동으로 구매 페이지로 이동합니다.",
        category="대기열",
    ),
    # 마일리지/포인트
    FAQEntry(
        keywords=["마일리지", "포인트", "적립", "포인트 사용"],
        question="마일리지/포인트는 어떻게 사용하나요?",
        answer="마일리지는 결제 시 현금처럼 사용할 수 있습니다. 마이페이지 > 포인트에서 잔액을 확인할 수 있으며, 이벤트 참여, 퀘스트 완료 등으로 적립됩니다.",
        category="포인트",
    ),
    # 추첨
    FAQEntry(
        keywords=["추첨", "로또", "당첨", "랜덤"],
        question="추첨 판매는 어떻게 진행되나요?",
        answer="추첨 판매는 신청 기간 동안 응모한 후, 랜덤 추첨으로 당첨자를 선정합니다. 당첨 결과는 알림 및 마이페이지에서 확인할 수 있으며, 당첨 시 지정된 기간 내에 결제를 완료해야 합니다.",
        category="추첨",
    ),
    # 고객센터
    FAQEntry(
        keywords=["고객센터", "전화", "상담원", "문의", "연락처", "이메일 문의"],
        question="고객센터에 연락하고 싶어요.",
        answer="고객센터 운영시간은 평일 09:00~18:00입니다. 이메일(support@pickket.kr)로 문의하시거나, 챗봇의 '상담원 연결' 버튼을 눌러 상담을 요청하실 수 있습니다.",
        category="고객센터",
    ),
    # 리셀(재판매)
    FAQEntry(
        keywords=["리셀", "재판매", "중고 티켓", "되팔기"],
        question="티켓 리셀(재판매)이 가능한가요?",
        answer="피켓에서는 공식 리셀 시스템을 통해 안전한 재판매가 가능합니다. 주최자가 리셀을 허용한 이벤트에 한해 이용 가능하며, 원래 가격 이하로만 거래됩니다.",
        category="리셀",
    ),
    # QR/체크인
    FAQEntry(
        keywords=["QR", "입장", "체크인", "QR코드", "입장 방법"],
        question="입장은 어떻게 하나요?",
        answer="마이페이지 > 티켓에서 QR코드를 확인할 수 있습니다. 이벤트 당일 입구에서 QR코드를 스캔하여 입장합니다. QR코드는 보안을 위해 일정 시간마다 갱신됩니다.",
        category="입장",
    ),
]


def _normalize(text: str) -> str:
    """검색용 텍스트 정규화 — 소문자, 공백 제거."""
    return re.sub(r"\s+", "", text.lower())


def match_faq(user_message: str) -> tuple[FAQEntry | None, float]:
    """키워드 매칭으로 FAQ 검색. (entry, confidence) 반환."""
    normalized = _normalize(user_message)
    best_entry: FAQEntry | None = None
    best_score = 0.0

    for entry in FAQ_DATABASE:
        matched_count = 0
        total_keywords = len(entry.keywords)
        for kw in entry.keywords:
            if _normalize(kw) in normalized:
                matched_count += 1

        if matched_count == 0:
            continue

        # 기본 점수: 1개만 매칭되어도 0.7 이상 (의도 파악 가능)
        # 여러 키워드 매칭 시 보너스
        if matched_count >= 2:
            score = 0.9 + min((matched_count - 2) * 0.025, 0.1)
        else:
            score = 0.7 + (0.2 * matched_count / max(total_keywords, 1))
        # 짧은 메시지(단일 주제)는 확신도 증가
        if len(user_message) < 15 and matched_count >= 1:
            score = min(score + 0.15, 1.0)

        if score > best_score:
            best_score = score
            best_entry = entry

    return best_entry, best_score


def search_faq_entries(query: str, limit: int = 3) -> list[dict[str, str]]:
    """FAQ 검색 (LLM tool용) — 관련 FAQ 항목 반환."""
    normalized = _normalize(query)
    results: list[tuple[float, FAQEntry]] = []

    for entry in FAQ_DATABASE:
        score = 0.0
        for kw in entry.keywords:
            if _normalize(kw) in normalized:
                score += 1.0
        if score > 0:
            results.append((score, entry))

    results.sort(key=lambda x: x[0], reverse=True)
    return [
        {"question": e.question, "answer": e.answer, "category": e.category}
        for _, e in results[:limit]
    ]


# ── Tier 1: LLM 도구 정의 ───────────────────────────────────────────────────

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "get_order_status",
            "description": "주문 ID로 주문 상태를 조회합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "order_id": {
                        "type": "string",
                        "description": "조회할 주문 ID (UUID)",
                    }
                },
                "required": ["order_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_ticket_status",
            "description": "티켓 ID로 티켓 상태를 조회합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ticket_id": {
                        "type": "string",
                        "description": "조회할 티켓 ID (UUID)",
                    }
                },
                "required": ["ticket_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_event_info",
            "description": "이벤트 ID로 이벤트 정보를 조회합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "event_id": {
                        "type": "string",
                        "description": "조회할 이벤트 ID (UUID)",
                    }
                },
                "required": ["event_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_faq",
            "description": "FAQ 데이터베이스에서 관련 질문/답변을 검색합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "검색 쿼리",
                    }
                },
                "required": ["query"],
            },
        },
    },
]

SYSTEM_PROMPT = """당신은 피켓(Pickket) 고객지원 AI 어시스턴트입니다.

피켓은 멀티 분야 공정 티켓 플랫폼으로, VCG 메커니즘과 팬 가중치를 활용한 공정한 티켓 배분 서비스를 제공합니다.

역할:
- 주문, 환불, 결제, 티켓, 이벤트 관련 질문에 친절하게 답변합니다.
- 사용자의 주문/티켓 상태를 조회하여 정확한 정보를 제공합니다.
- FAQ를 검색하여 관련 정보를 찾습니다.

절대 금지:
- 환불을 약속하거나 보장하지 마세요. "환불 처리해 드리겠습니다"와 같은 표현은 금지입니다.
- 가격 보장, 할인 약속을 하지 마세요.
- 개인정보(비밀번호, 카드번호 등)를 요청하지 마세요.
- 확실하지 않은 정보를 확신하는 것처럼 답변하지 마세요.

복잡한 문제(환불 분쟁, 결제 오류, 개인정보 변경 등)는 상담원 연결을 안내하세요.

답변은 간결하고 명확하게, 한국어로 작성해주세요."""


# ── 도구 실행 ─────────────────────────────────────────────────────────────────

async def _execute_tool(
    tool_name: str,
    arguments: dict[str, Any],
    db: AsyncSession,
    user_id: str | None = None,
) -> str:
    """LLM 도구 호출 실행."""
    try:
        if tool_name == "get_order_status":
            return await _tool_get_order_status(arguments["order_id"], db, user_id)
        elif tool_name == "get_ticket_status":
            return await _tool_get_ticket_status(arguments["ticket_id"], db, user_id)
        elif tool_name == "get_event_info":
            return await _tool_get_event_info(arguments["event_id"], db)
        elif tool_name == "search_faq":
            return json.dumps(
                search_faq_entries(arguments["query"]),
                ensure_ascii=False,
            )
        else:
            return json.dumps({"error": f"알 수 없는 도구: {tool_name}"})
    except Exception as e:
        logger.error("Tool execution error (%s): %s", tool_name, e)
        return json.dumps({"error": "도구 실행 중 오류가 발생했습니다."})


async def _tool_get_order_status(
    order_id: str, db: AsyncSession, user_id: str | None
) -> str:
    """주문 상태 조회 도구."""
    try:
        oid = uuid.UUID(order_id)
    except ValueError:
        return json.dumps({"error": "유효하지 않은 주문 ID입니다."})

    result = await db.execute(select(Order).where(Order.id == oid))
    order = result.scalar_one_or_none()
    if not order:
        return json.dumps({"error": "주문을 찾을 수 없습니다."})

    # 인증된 사용자의 주문만 조회 허용
    if user_id and str(order.user_id) != user_id:
        return json.dumps({"error": "해당 주문에 접근할 수 없습니다."})

    return json.dumps(
        {
            "order_id": str(order.id),
            "status": order.status,
            "total_amount": float(order.total_amount) if order.total_amount else 0,
            "created_at": order.created_at.isoformat() if order.created_at else None,
        },
        ensure_ascii=False,
    )


async def _tool_get_ticket_status(
    ticket_id: str, db: AsyncSession, user_id: str | None
) -> str:
    """티켓 상태 조회 도구."""
    try:
        tid = uuid.UUID(ticket_id)
    except ValueError:
        return json.dumps({"error": "유효하지 않은 티켓 ID입니다."})

    result = await db.execute(select(Ticket).where(Ticket.id == tid))
    ticket = result.scalar_one_or_none()
    if not ticket:
        return json.dumps({"error": "티켓을 찾을 수 없습니다."})

    if user_id and str(ticket.user_id) != user_id:
        return json.dumps({"error": "해당 티켓에 접근할 수 없습니다."})

    return json.dumps(
        {
            "ticket_id": str(ticket.id),
            "status": ticket.status,
            "event_id": str(ticket.event_id) if ticket.event_id else None,
        },
        ensure_ascii=False,
    )


async def _tool_get_event_info(event_id: str, db: AsyncSession) -> str:
    """이벤트 정보 조회 도구."""
    try:
        eid = uuid.UUID(event_id)
    except ValueError:
        return json.dumps({"error": "유효하지 않은 이벤트 ID입니다."})

    result = await db.execute(select(Event).where(Event.id == eid))
    event = result.scalar_one_or_none()
    if not event:
        return json.dumps({"error": "이벤트를 찾을 수 없습니다."})

    return json.dumps(
        {
            "event_id": str(event.id),
            "title": event.title,
            "status": event.status if hasattr(event, "status") else None,
            "category": event.category if hasattr(event, "category") else None,
            "start_date": event.start_date.isoformat() if hasattr(event, "start_date") and event.start_date else None,
            "venue": event.venue_name if hasattr(event, "venue_name") else None,
        },
        ensure_ascii=False,
    )


# ── 이벤트별 context 로드 (단순 이벤트 정보 조회 — 에이전트/quota 아님) ──────────
#
# 챗봇이 특정 이벤트 페이지에서 열렸을 때(eventId 전달), 해당 이벤트의 공개 정보를
# 로드해 LLM 시스템프롬프트에 주입한다. 이로써 "이 공연 언제/어디서/얼마" 같은
# 이벤트-특정 질문에 정확히 답할 수 있다(글로벌 CS 무관 응답 방지).
#
# 정보 소스: v2 events / seat_tiers 테이블(SSOT). AI 폐기(1차 B)와 무관 — 단순 조회.

# go 판매상태 투영과 동일한 어휘로 소비자에게 노출.
_SALE_STATUS_LABELS = {
    "on_sale": "판매중",
    "sold_out": "매진",
    "paused": "판매 일시중지",
    "scheduled": "판매 예정",
    "closed": "판매 종료",
    "cancelled": "취소됨",
    "unavailable": "판매 대기",
}


def _derive_sale_status(event: Event, tiers: list[SeatTier]) -> str:
    """이벤트 status·sales_paused·재고로 소비자용 판매상태 라벨 파생.

    v2 status(SSOT)를 소비자 어휘로 투영. go 표시 규약과 동일한 우선순위:
    취소 > 종료 > 일시중지 > 매진 > 판매중 > 예정 > 대기.
    """
    status = getattr(event, "status", None)
    status_val = status.value if hasattr(status, "value") else str(status or "")

    if status_val == "cancelled":
        return _SALE_STATUS_LABELS["cancelled"]
    if status_val in ("completed", "allocated", "bidding_closed", "allocating"):
        return _SALE_STATUS_LABELS["closed"]
    if getattr(event, "sales_paused", False):
        return _SALE_STATUS_LABELS["paused"]

    live = status_val in ("bidding_open", "approved")
    if live and tiers:
        total_cap = sum(int(t.capacity or 0) for t in tiers)
        total_sold = sum(int(t.sold_count or 0) for t in tiers)
        if total_cap > 0 and total_sold >= total_cap:
            return _SALE_STATUS_LABELS["sold_out"]
    if live:
        return _SALE_STATUS_LABELS["on_sale"]
    if status_val in ("draft", "pending_review", "under_review", "revision_requested"):
        return _SALE_STATUS_LABELS["scheduled"]
    return _SALE_STATUS_LABELS["unavailable"]


def _search_faq_for_category(category: str | None, limit: int = 3) -> list[FAQEntry]:
    """이벤트 카테고리와 느슨히 연관된 FAQ 상위 항목(맥락 힌트용)."""
    if not category:
        return FAQ_DATABASE[:limit]
    normalized = _normalize(category)
    scored: list[tuple[float, FAQEntry]] = []
    for entry in FAQ_DATABASE:
        score = 1.0 if _normalize(entry.category) in normalized or normalized in _normalize(entry.category) else 0.0
        scored.append((score, entry))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [e for _, e in scored[:limit]]


async def build_event_context(event_id: str, db: AsyncSession) -> str | None:
    """eventId 로 이벤트 공개 정보를 로드해 LLM context 블록(한국어) 생성.

    반환 None → 유효하지 않은 id 이거나 이벤트 없음(context 미주입, 글로벌 CS 로 동작).
    """
    try:
        eid = uuid.UUID(event_id)
    except (ValueError, AttributeError):
        return None

    result = await db.execute(select(Event).where(Event.id == eid))
    event = result.scalar_one_or_none()
    if not event:
        return None

    tiers_result = await db.execute(
        select(SeatTier).where(SeatTier.event_id == eid).order_by(SeatTier.base_price)
    )
    tiers = list(tiers_result.scalars().all())

    lines: list[str] = ["[현재 문의 대상 이벤트 정보]"]
    lines.append(f"- 제목: {event.title}")

    event_date = getattr(event, "event_date", None)
    if event_date:
        lines.append(f"- 일시: {event_date.isoformat()}")
    venue = getattr(event, "venue", None)
    if venue:
        venue_line = f"- 장소: {venue}"
        addr = getattr(event, "venue_address", None)
        if addr:
            venue_line += f" ({addr})"
        lines.append(venue_line)
    if getattr(event, "is_online", False):
        lines.append("- 온라인 이벤트")
    category = getattr(event, "category", None)
    if category:
        lines.append(f"- 분야: {category}")
    if getattr(event, "artist_name", None):
        lines.append(f"- 출연/주체: {event.artist_name}")

    lines.append(f"- 판매상태: {_derive_sale_status(event, tiers)}")

    if tiers:
        tier_parts: list[str] = []
        for t in tiers:
            price = int(t.base_price or 0)
            cap = int(t.capacity or 0)
            sold = int(t.sold_count or 0)
            remaining = max(cap - sold, 0)
            avail = "매진" if cap > 0 and remaining <= 0 else f"잔여 {remaining}석"
            tier_parts.append(f"{t.name} {price:,}원({avail})")
        lines.append("- 티켓 등급: " + " / ".join(tier_parts))
    else:
        lines.append("- 티켓 등급: 등록된 티켓 정보 없음")

    if getattr(event, "age_rating", None):
        lines.append(f"- 관람연령: {event.age_rating}")
    if getattr(event, "context_banner", None):
        lines.append(f"- 공지: {event.context_banner}")
    if getattr(event, "notice", None):
        # 공지 원문은 길 수 있어 앞부분만.
        notice = str(event.notice).strip().replace("\n", " ")
        lines.append(f"- 주최자 안내: {notice[:300]}")

    related = _search_faq_for_category(category)
    if related:
        lines.append("[관련 FAQ 요약]")
        for e in related:
            lines.append(f"- Q: {e.question} / A: {e.answer}")

    lines.append(
        "위 정보는 현재 문의 대상 이벤트에 대한 사실 정보다. "
        "이 이벤트에 관한 질문에는 위 정보를 근거로 정확히 답하라. "
        "위에 없는 세부사항은 추측하지 말고 확인이 필요하다고 안내하라."
    )
    return "\n".join(lines)


# ── Tier 1: LLM 호출 ────────────────────────────────────────────────────────

ESCALATION_KEYWORDS = [
    "상담원", "사람", "직원", "전화", "담당자",
    "에스컬레이션", "항의", "소송", "법적", "신고",
]


@dataclass
class ChatResponse:
    response: str
    tier: int
    conversation_id: str
    escalated: bool = False


@dataclass
class ConversationContext:
    messages: list[dict[str, str]] = field(default_factory=list)
    created_at: float = 0.0
    # 소유자 바인딩: "user:{id}" (회원) 또는 "guest" (비회원 bearer).
    # 회원 대화는 다른 회원/비회원이 conversation_id 를 제시해도 접근 불가.
    owner: str = "guest"


_MAX_CONVERSATION_MESSAGES = 20

# ── 대화 저장소 (Redis, 멀티워커 안전 + 세션 바인딩) ────────────────────────────
#
# 프로세스 메모리 dict → Redis 로 이관. 이유(코덱스 지적):
#  (1) 멀티워커: 워커마다 다른 메모리 → 대화 유실. Redis 는 워커 무관 조회.
#  (2) 타세션 접근: conversation_id 는 서버 발급 uuid4(bearer capability). 추가로
#      회원 대화는 owner 를 저장·검증해 다른 회원/비회원의 접근을 차단.
#
# 키 규약: v2: prefix 강제(DOMAIN_MODEL_STANDARD §7). "v2:chat:conv:{conversation_id}".
# TTL: settings.CHATBOT_CONVERSATION_TTL(기본 1h). 접근마다 갱신(sliding).

_CONV_KEY_PREFIX = "chat:conv:"


def _conv_redis_key(conversation_id: str) -> str:
    return v2_key(f"{_CONV_KEY_PREFIX}{conversation_id}")


def _owner_key(user_id: str | None) -> str:
    """현재 요청자의 소유자 식별자. 회원=user:{id}, 비회원=guest(bearer)."""
    return f"user:{user_id}" if user_id else "guest"


async def _load_conversation(
    conversation_id: str | None, owner: str
) -> tuple[str, ConversationContext]:
    """conversation_id 로 Redis 대화 로드 + 소유자 검증.

    - conversation_id 없음/미존재/손상 → 신규 대화(uuid4 발급).
    - 저장된 owner 가 회원(user:*)인데 요청자 owner 와 다르면 → 접근 거부(신규 대화).
      회원 대화는 세션에 강하게 바인딩되어 타인이 conversation_id 를 알아도 이어갈 수 없다.
    - 저장된 owner 가 guest 면 → conversation_id(uuid4) 소지가 곧 자격(bearer).
    """
    import time

    if conversation_id:
        try:
            r = get_redis()
            raw = await r.get(_conv_redis_key(conversation_id))
        except Exception as e:  # Redis 장애 → graceful: 신규 대화로 진행
            logger.warning("대화 로드 실패(Redis) — 신규 대화로 진행: %s", e)
            raw = None

        if raw:
            try:
                data = json.loads(raw)
                stored_owner = str(data.get("owner", "guest"))
                # 세션 격리: 회원 대화는 동일 회원만 이어갈 수 있다.
                if stored_owner.startswith("user:") and stored_owner != owner:
                    logger.warning(
                        "대화 소유자 불일치 — 접근 거부, 신규 대화 발급 "
                        "(stored=%s requester=%s)",
                        stored_owner,
                        owner,
                    )
                else:
                    ctx = ConversationContext(
                        messages=list(data.get("messages", [])),
                        created_at=float(data.get("created_at", time.time())),
                        owner=stored_owner,
                    )
                    return conversation_id, ctx
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                logger.warning("대화 역직렬화 실패 — 신규 대화: %s", e)

    # 신규 대화
    new_id = str(uuid.uuid4())
    return new_id, ConversationContext(messages=[], created_at=time.time(), owner=owner)


async def _persist_conversation(conversation_id: str, ctx: ConversationContext) -> None:
    """대화를 Redis 에 저장(TTL 갱신). Redis 장애 시 무음(대화 유실만, 응답은 정상)."""
    _trim_conversation(ctx)
    try:
        r = get_redis()
        payload = json.dumps(
            {
                "messages": ctx.messages,
                "created_at": ctx.created_at,
                "owner": ctx.owner,
            },
            ensure_ascii=False,
            default=str,
        )
        await r.setex(
            _conv_redis_key(conversation_id),
            settings.CHATBOT_CONVERSATION_TTL,
            payload,
        )
    except Exception as e:
        logger.warning("대화 저장 실패(Redis) — 이력 미보존: %s", e)


def _should_escalate(message: str) -> bool:
    """에스컬레이션 필요 여부 판단."""
    normalized = _normalize(message)
    return any(_normalize(kw) in normalized for kw in ESCALATION_KEYWORDS)


async def handle_chat_message(
    message: str,
    conversation_id: str | None,
    db: AsyncSession,
    user_id: str | None = None,
    event_id: str | None = None,
) -> ChatResponse:
    """챗봇 메시지 처리 — Tier 0 → Tier 1 에스컬레이션 흐름.

    event_id: 특정 이벤트 페이지에서 열린 챗봇이면 해당 이벤트 context 를 LLM 에 주입.
    """
    owner = _owner_key(user_id)

    # 대화 로드(Redis) + 소유자 검증
    conversation_id, ctx = await _load_conversation(conversation_id, owner)

    # 에스컬레이션 체크 (이력·소유자 저장 없이 조기 반환 — 상태 무변)
    if _should_escalate(message):
        return ChatResponse(
            response="상담원에게 연결해 드리겠습니다. 잠시만 기다려주세요. 운영시간(평일 09:00~18:00) 외에는 이메일(support@pickket.kr)로 문의해주시면 빠르게 답변드리겠습니다.",
            tier=0,
            conversation_id=conversation_id,
            escalated=True,
        )

    # Tier 0: 키워드 FAQ 매칭
    faq_entry, confidence = match_faq(message)
    if faq_entry and confidence >= 0.8:
        ctx.messages.append({"role": "user", "content": message})
        ctx.messages.append({"role": "assistant", "content": faq_entry.answer})
        await _persist_conversation(conversation_id, ctx)
        return ChatResponse(
            response=faq_entry.answer,
            tier=0,
            conversation_id=conversation_id,
            escalated=False,
        )

    # Tier 1: LLM (설정되지 않으면 Tier 0 fallback)
    if not settings.CHATBOT_LLM_API_URL:
        # LLM 미설정 — FAQ 근사 매칭 또는 기본 응답
        if faq_entry and confidence >= 0.4:
            response_text = faq_entry.answer
        else:
            response_text = (
                "죄송합니다, 해당 질문에 대한 답변을 찾지 못했습니다. "
                "더 자세한 도움이 필요하시면 '상담원 연결'을 요청해주세요."
            )
        ctx.messages.append({"role": "user", "content": message})
        ctx.messages.append({"role": "assistant", "content": response_text})
        await _persist_conversation(conversation_id, ctx)
        return ChatResponse(
            response=response_text,
            tier=0,
            conversation_id=conversation_id,
            escalated=False,
        )

    # 이벤트별 context 로드(있으면 시스템프롬프트에 주입)
    event_context: str | None = None
    if event_id:
        try:
            event_context = await build_event_context(event_id, db)
        except Exception as e:
            logger.warning("이벤트 context 로드 실패(무시하고 진행): %s", e)

    # Tier 1: LLM 호출
    try:
        response_text = await _call_llm(message, ctx, db, user_id, event_context)
        ctx.messages.append({"role": "user", "content": message})
        ctx.messages.append({"role": "assistant", "content": response_text})
        await _persist_conversation(conversation_id, ctx)
        return ChatResponse(
            response=response_text,
            tier=1,
            conversation_id=conversation_id,
            escalated=False,
        )
    except Exception as e:
        logger.error("LLM call failed: %s", e)
        # LLM 실패 시 Tier 0 fallback
        if faq_entry and confidence >= 0.3:
            return ChatResponse(
                response=faq_entry.answer,
                tier=0,
                conversation_id=conversation_id,
                escalated=False,
            )
        return ChatResponse(
            response="일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
            tier=0,
            conversation_id=conversation_id,
            escalated=False,
        )


async def _call_llm(
    message: str,
    ctx: ConversationContext,
    db: AsyncSession,
    user_id: str | None,
    event_context: str | None = None,
) -> str:
    """OpenAI-compatible API 호출 (도구 호출 포함)."""
    system_content = SYSTEM_PROMPT
    if event_context:
        system_content = f"{SYSTEM_PROMPT}\n\n{event_context}"
    messages = [{"role": "system", "content": system_content}]
    # 대화 이력 추가
    messages.extend(ctx.messages[-10:])
    messages.append({"role": "user", "content": message})

    max_tool_rounds = 3
    for _ in range(max_tool_rounds):
        payload: dict[str, Any] = {
            "model": settings.CHATBOT_LLM_MODEL,
            "messages": messages,
            "max_tokens": settings.CHATBOT_MAX_TOKENS,
            "temperature": 0.7,
            "tools": TOOL_DEFINITIONS,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            headers = traced_headers({"Content-Type": "application/json"})
            if settings.CHATBOT_LLM_API_KEY:
                headers["Authorization"] = f"Bearer {settings.CHATBOT_LLM_API_KEY}"

            resp = await client.post(
                f"{settings.CHATBOT_LLM_API_URL}/chat/completions",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()

        choice = data["choices"][0]
        msg = choice["message"]

        # 도구 호출이 없으면 최종 응답
        if not msg.get("tool_calls"):
            return msg.get("content", "")

        # 도구 호출 실행
        messages.append(msg)
        for tool_call in msg["tool_calls"]:
            fn = tool_call["function"]
            tool_name = fn["name"]
            try:
                arguments = json.loads(fn["arguments"])
            except json.JSONDecodeError:
                arguments = {}

            result = await _execute_tool(tool_name, arguments, db, user_id)
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call["id"],
                "content": result,
            })

    # 최대 도구 호출 횟수 초과 — 마지막 응답 반환
    return messages[-1].get("content", "죄송합니다, 처리 중 문제가 발생했습니다.")


def _trim_conversation(ctx: ConversationContext) -> None:
    """대화 이력 최대 길이 제한."""
    if len(ctx.messages) > _MAX_CONVERSATION_MESSAGES:
        ctx.messages = ctx.messages[-_MAX_CONVERSATION_MESSAGES:]


def cleanup_old_conversations(max_age_seconds: int = 3600) -> int:
    """대화 정리 — Redis 이관 후 no-op.

    대화는 Redis 에 TTL(settings.CHATBOT_CONVERSATION_TTL)로 저장되어 만료가 자동
    처리된다. 별도 주기적 정리가 불필요하므로 항상 0 을 반환한다(하위호환 유지).
    """
    _ = max_age_seconds
    return 0
