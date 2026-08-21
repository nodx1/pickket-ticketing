"""카카오 알림톡 승인 템플릿 상수 — go `organizer/src/lib/notification/alimtalk.ts` 의
``ALIMTALK_TEMPLATES`` **글자 그대로** 포팅.

⚠️ 절대 규칙
  - templateCode 는 **NCP SENS 콘솔 등록 코드와 정확히 일치**해야 발송된다.
    NCP 알림톡 템플릿 코드는 영문+숫자만 허용(언더바 불가)인 경우가 있어 신규 코드
    (``PICKKETINVITE001``)는 언더바가 없다. 기존 코드는 콘솔 등록값 그대로 유지한다 —
    임의 정규화(언더바 제거/대소문자 변경)는 **전 발송 실패**를 부른다.
  - 본문(body)도 카카오 승인 본문과 일치해야 한다(변수 치환 결과 기준). 문구 수정은
    카카오 재심사 대상이므로 코드에서 임의로 바꾸지 않는다.
  - ``PICKKETINVITE001`` 은 **카카오 승인 완료된 실사용 템플릿**(2026-07-25 배포)이다.

이 상수는 v2 가 알림톡 본문을 직접 조립하는 경로(트리거·리마인더 확장)를 위한 정본이며,
현재 단체 발송 경로는 event_messages.template_code + body 를 그대로 사용한다.
"""

from __future__ import annotations

from dataclasses import dataclass

# ── 템플릿 코드(콘솔 등록값과 1:1) ─────────────────────────────────────────────
PURCHASE_CONFIRM_CODE = "PICKKET_PURCHASE_001"
REMINDER_D7_CODE = "PICKKET_REMIND_D7"
REMINDER_D1_CODE = "PICKKET_REMIND_D1"
# 🔴 NCP 템플릿 코드는 **영문+숫자만** 받는다 — 언더바가 있으면 등록 자체가 불가하다.
#    옛 값 `PICKKET_CANCEL_001` 은 NCP 에 존재한 적이 없다.
#    승인·운영본은 go 쪽(`organizer/src/lib/notification/alimtalk-templates.ts:84`)의
#    `PICKKETCANCEL001` 이고, 실제 발송도 거기서 나간다(대표 확정 — go 단일 채널).
#    지금 v2 발송은 꺼져 있어 무해하지만, 되살리는 순간 **조용히 실패**하므로 값만 맞춰둔다.
CANCEL_CONFIRM_CODE = "PICKKETCANCEL001"
CHECKIN_QR_CODE = "PICKKET_CHECKIN_001"
INVITATION_ISSUED_CODE = "PICKKETINVITE001"  # 카카오 승인 완료(언더바 없음 — 콘솔과 일치)


def purchase_confirm_body(
    *,
    buyer_name: str,
    event_title: str,
    order_number: str,
    ticket_count: int,
    event_date: str,
) -> str:
    return (
        "[PICKKET] 구매가 완료되었습니다.\n\n"
        f"{buyer_name}님, {event_title}\n"
        f"주문번호: {order_number}\n"
        f"티켓 수: {ticket_count}매\n"
        f"일시: {event_date}\n\n"
        "내 티켓 확인: https://go.pickket.kr/my-tickets"
    )


def reminder_d7_body(
    *, buyer_name: str, event_title: str, event_date: str, venue_name: str
) -> str:
    return (
        f"[PICKKET] {event_title}\n\n"
        f"{buyer_name}님, 공연까지 7일 남았습니다!\n"
        f"일시: {event_date}\n"
        f"장소: {venue_name}\n\n"
        "내 티켓 확인: https://go.pickket.kr/my-tickets"
    )


def reminder_d1_body(
    *, buyer_name: str, event_title: str, event_date: str, venue_name: str
) -> str:
    return (
        f"[PICKKET] {event_title}\n\n"
        f"{buyer_name}님, 내일입니다!\n"
        f"일시: {event_date}\n"
        f"장소: {venue_name}\n"
        "체크인: 모바일 티켓의 QR 코드를 준비해주세요.\n\n"
        "내 티켓: https://go.pickket.kr/my-tickets"
    )


def cancel_confirm_body(
    *, buyer_name: str, event_title: str, refund_amount: str
) -> str:
    return (
        "[PICKKET] 취소가 완료되었습니다.\n\n"
        f"{buyer_name}님, {event_title}\n"
        f"환불 금액: {refund_amount}\n"
        "환불은 결제 수단에 따라 3-5영업일 소요될 수 있습니다."
    )


def checkin_qr_body(*, buyer_name: str, event_title: str, ticket_url: str) -> str:
    return (
        f"[PICKKET] {event_title}\n\n"
        f"{buyer_name}님, 아래 링크에서 QR 코드를 확인하세요.\n"
        f"{ticket_url}\n\n"
        "입장 시 화면의 QR 코드를 제시해주세요."
    )


def invitation_issued_body(
    *, event_title: str, event_date: str, venue_name: str
) -> str:
    """F2 초대권 발급 안내 — 정보성(발권 완료) 톤. 광고성 금지.

    링크는 본문 인라인 URL 이 아니라 '모바일 티켓' 웹링크 **버튼**으로 전달한다
    (카카오 승인 템플릿 버튼과 일치해야 함).
    """
    return (
        f"[초대권] {event_title} 초대권\n\n"
        "안녕하세요.\n"
        f"{event_title} 초대권 서비스 '피켓'입니다.\n\n"
        f"고객님께서 요청하신 {event_title} 초대권이 도착했습니다.\n\n"
        f"▶ 대회일자 : {event_date}\n"
        f"▶ 대회명 : {event_title}\n"
        "▶ 티켓명 : 모바일 초대권\n\n"
        f"※ 대회장소 : {venue_name}\n\n"
        "※ 입장안내\n"
        "대회장 매표소에서 아래 '모바일 티켓'을 눌러\n"
        "안내페이지에 모바일 초대권(QR)을 보여주시기 바랍니다.\n\n"
        "※ 본 초대권의 사용은 대회기간 중 1회에 한합니다.\n\n"
        "※ 캡쳐된 모바일 초대권은 입장이 제한되오니 주의하여 주시기 바랍니다."
    )


@dataclass(frozen=True)
class AlimtalkTemplate:
    code: str
    title: str


ALIMTALK_TEMPLATES: dict[str, AlimtalkTemplate] = {
    "PURCHASE_CONFIRM": AlimtalkTemplate(PURCHASE_CONFIRM_CODE, "구매 확인"),
    "REMINDER_D7": AlimtalkTemplate(REMINDER_D7_CODE, "D-7 리마인더"),
    "REMINDER_D1": AlimtalkTemplate(REMINDER_D1_CODE, "D-1 리마인더"),
    "CANCEL_CONFIRM": AlimtalkTemplate(CANCEL_CONFIRM_CODE, "취소/환불 확인"),
    "CHECKIN_QR": AlimtalkTemplate(CHECKIN_QR_CODE, "체크인 안내"),
    "INVITATION_ISSUED": AlimtalkTemplate(INVITATION_ISSUED_CODE, "초대권 발급 안내"),
}


__all__ = [
    "ALIMTALK_TEMPLATES",
    "AlimtalkTemplate",
    "CANCEL_CONFIRM_CODE",
    "CHECKIN_QR_CODE",
    "INVITATION_ISSUED_CODE",
    "PURCHASE_CONFIRM_CODE",
    "REMINDER_D1_CODE",
    "REMINDER_D7_CODE",
    "cancel_confirm_body",
    "checkin_qr_body",
    "invitation_issued_body",
    "purchase_confirm_body",
    "reminder_d1_body",
    "reminder_d7_body",
]
