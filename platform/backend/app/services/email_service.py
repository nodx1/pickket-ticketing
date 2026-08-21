"""Email service with provider abstraction.

External sends (SES / SendGrid) are wrapped with @with_retry for transient failures.
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.core.config import settings
from app.core.http_client import traced_headers
from app.core.pii import mask_email
from app.core.resilience import with_retry

logger = logging.getLogger(__name__)


def get_ticket_noun(category: str) -> str:
    """Return domain-adaptive ticket noun based on event category."""
    category_lower = category.lower() if category else ""
    if category_lower == "sports":
        return "관전권"
    if category_lower in ("exhibition", "festival"):
        return "입장권"
    return "티켓"


@dataclass
class EmailMessage:
    to: str
    subject: str
    body_text: str
    body_html: str | None = None


TEMPLATES = {
    "allocation_won": {
        "subject": "[Pickket] 축하합니다! {ticket_noun}을 획득했어요",
        "body": (
            "안녕하세요 {name}님,\n\n"
            "{event_title} 이벤트에서 {ticket_noun}을 획득하셨습니다.\n"
            "최종 결제가: {final_price}원\n\n"
            "24시간 내에 결제를 완료해주세요.\n"
            "결제하기: {payment_url}\n\n"
            "감사합니다,\nPickket 팀"
        ),
    },
    "allocation_lost": {
        "subject": "[Pickket] {event_title} 배분 결과 안내",
        "body": (
            "안녕하세요 {name}님,\n\n"
            "아쉽게도 {event_title} 이벤트에서 이번에는 {ticket_noun}을 획득하지 못했어요.\n\n"
            "다음 기회에 꼭 만나요!\n"
            "리세일 마켓에서 찾아보기: {resale_url}\n\n"
            "감사합니다,\nPickket 팀"
        ),
    },
    "payment_reminder": {
        "subject": "[Pickket] 결제 마감이 다가오고 있어요",
        "body": (
            "안녕하세요 {name}님,\n\n"
            "{event_title} {ticket_noun} 결제 마감까지 {hours_left}시간 남았습니다.\n"
            "기한 내 결제하지 않으면 다음 대기자에게 넘어갑니다.\n\n"
            "결제하기: {payment_url}\n\n"
            "감사합니다,\nPickket 팀"
        ),
    },
    "waitlist_offered": {
        "subject": "[Pickket] 대기 순서가 도래했어요!",
        "body": (
            "안녕하세요 {name}님,\n\n"
            "{event_title} 대기열에서 순서가 도래했습니다.\n"
            "24시간 내에 결제를 완료해주세요.\n\n"
            "결제하기: {payment_url}\n\n"
            "감사합니다,\nPickket 팀"
        ),
    },
    "payment_complete": {
        "subject": "[Pickket] 결제 완료! {ticket_noun}이 발급되었어요",
        "body": (
            "안녕하세요 {name}님,\n\n"
            "{event_title} {ticket_noun} 결제가 완료되었습니다.\n"
            "결제 금액: {amount}원\n\n"
            "마이페이지에서 {ticket_noun}을 확인하세요.\n"
            "내 {ticket_noun} 보기: {ticket_url}\n\n"
            "감사합니다,\nPickket 팀"
        ),
    },
    "refund_complete": {
        "subject": "[Pickket] 환불이 완료되었습니다",
        "body": (
            "안녕하세요 {name}님,\n\n"
            "{event_title} {ticket_noun} 환불이 완료되었습니다.\n"
            "환불 금액: {amount}원\n\n"
            "감사합니다,\nPickket 팀"
        ),
    },
}


class EmailProvider(ABC):
    @abstractmethod
    async def send(self, to: str, subject: str, html_body: str) -> bool: ...


class StubEmailProvider(EmailProvider):
    async def send(self, to: str, subject: str, html_body: str) -> bool:
        logger.info("STUB EMAIL → to=%s subject=%s", mask_email(to), subject)
        return True


class SESEmailProvider(EmailProvider):
    @with_retry(max_attempts=3, backoff_base=2, retry_on=(Exception,), exclude=(ValueError,))
    async def send(self, to: str, subject: str, html_body: str) -> bool:
        import aioboto3

        session = aioboto3.Session()
        async with session.client("ses", region_name=settings.AWS_SES_REGION) as ses:
            await ses.send_email(
                Source=settings.EMAIL_FROM_ADDRESS or settings.AWS_SES_FROM,
                Destination={"ToAddresses": [to]},
                Message={
                    "Subject": {"Data": subject, "Charset": "UTF-8"},
                    "Body": {"Html": {"Data": html_body, "Charset": "UTF-8"}},
                },
            )
        return True


class SendGridEmailProvider(EmailProvider):
    @with_retry(max_attempts=3, backoff_base=2, retry_on=(Exception,), exclude=(ValueError,))
    async def send(self, to: str, subject: str, html_body: str) -> bool:
        import httpx

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.sendgrid.com/v3/mail/send",
                headers=traced_headers({"Authorization": f"Bearer {settings.SENDGRID_API_KEY}"}),
                json={
                    "personalizations": [{"to": [{"email": to}]}],
                    "from": {"email": settings.EMAIL_FROM_ADDRESS or settings.SENDGRID_FROM},
                    "subject": subject,
                    "content": [{"type": "text/html", "value": html_body}],
                },
            )
            return resp.status_code in (200, 201, 202)


def get_email_provider() -> EmailProvider:
    providers = {
        "ses": SESEmailProvider,
        "sendgrid": SendGridEmailProvider,
        "stub": StubEmailProvider,
    }
    cls = providers.get(settings.EMAIL_PROVIDER, StubEmailProvider)
    return cls()


class EmailService:
    """Email service. Async provider methods + sync template sender for tasks."""

    def __init__(self, *, smtp_host: str | None = None):
        self.provider = get_email_provider()
        self.smtp_host = smtp_host
        self._mock_mode = smtp_host is None

    def send(self, msg: EmailMessage) -> bool:
        """Synchronous send entrypoint for Celery sync tasks."""
        if self._mock_mode:
            logger.info("[MOCK EMAIL] To=%s Subject=%s", mask_email(msg.to), msg.subject)
            return True
        logger.info("Sending email to %s: %s", mask_email(msg.to), msg.subject)
        return True

    def render(self, template_key: str, **kwargs) -> EmailMessage:
        """Render a text email from template key."""
        tmpl = TEMPLATES.get(template_key)
        if not tmpl:
            raise ValueError(f"Unknown template: {template_key}")
        # Inject domain-adaptive ticket noun if not explicitly provided
        if "ticket_noun" not in kwargs:
            kwargs["ticket_noun"] = get_ticket_noun(kwargs.get("category", ""))
        return EmailMessage(
            to=kwargs.get("email", ""),
            subject=tmpl["subject"].format(**kwargs),
            body_text=tmpl["body"].format(**kwargs),
        )

    async def send_welcome(self, to: str, name: str) -> bool:
        html = (
            f"<h1>Pickket에 오신 것을 환영합니다, {name}님!</h1>"
            "<p>공정한 티켓 세상을 함께 만들어요.</p>"
        )
        return await self.provider.send(to, "Pickket에 오신 것을 환영합니다!", html)

    async def send_bid_won(
        self, to: str, name: str, event_title: str, price: float, category: str = ""
    ) -> bool:
        noun = get_ticket_noun(category)
        html = (
            f"<h1>축하합니다, {name}님!</h1>"
            f"<p><b>{event_title}</b> {noun}에 당선되었습니다.</p>"
            f"<p>결제 금액: {price:,.0f}원</p>"
        )
        return await self.provider.send(to, f"[Pickket] {event_title} 낙찰 알림", html)

    async def send_payment_confirmed(
        self, to: str, name: str, event_title: str, amount: float, category: str = ""
    ) -> bool:
        noun = get_ticket_noun(category)
        html = (
            "<h1>결제가 완료되었습니다</h1>"
            f"<p>{name}님, <b>{event_title}</b> {noun} 결제가 확인되었습니다.</p>"
            f"<p>결제 금액: {amount:,.0f}원</p>"
        )
        return await self.provider.send(to, f"[Pickket] 결제 확인 — {event_title}", html)

    async def send_ticket_issued(
        self, to: str, name: str, event_title: str, ticket_id: str, category: str = ""
    ) -> bool:
        noun = get_ticket_noun(category)
        html = (
            f"<h1>{noun}이 발급되었습니다</h1>"
            f"<p>{name}님, <b>{event_title}</b> {noun}이 발급되었습니다.</p>"
            f"<p>{noun} ID: {ticket_id}</p>"
        )
        return await self.provider.send(to, f"[Pickket] {noun} 발급 — {event_title}", html)

    async def send_refund_completed(self, to: str, name: str, amount: float) -> bool:
        html = (
            f"<h1>환불이 완료되었습니다</h1><p>{name}님, {amount:,.0f}원이 환불 처리되었습니다.</p>"
        )
        return await self.provider.send(to, "[Pickket] 환불 완료 알림", html)


email_service = EmailService()


# ════════════════════════════════════════════════════════════════════════
# 게스트(비회원) 매직링크 발송 (상세페이지 통합 F2)
#
#   게스트는 세션이 없으므로 재방문(조회/환불/회원승격)은 이메일 매직링크로만 가능하다.
#   raw 토큰(1회성)은 응답 노출을 최소화하고 **이메일로 발송**한다. 링크는 consumer 재방문
#   페이지 `/{locale}/guests/orders/{order_id}?token=<raw>` 를 가리킨다.
#
#   격리(best-effort): 발송은 주문/토큰 트랜잭션 **커밋 후** 호출되며, 실패해도 예외를
#   호출자로 전파하지 않는다(로깅만). 이메일 실패가 주문/토큰 성공을 깨서는 안 된다.
#   PII: 로그에는 mask_email 만, 본문에는 토큰 링크만(과다 PII 미노출).
# ════════════════════════════════════════════════════════════════════════

# view/refund/claim 별 발송 카피. purpose 는 URL 이 아니라 안내 문구·CTA 만 결정한다
# (재방문 페이지는 동일 URL 에서 token 의 purpose 로 분기).
_GUEST_MAGIC_SUBJECTS = {
    "order_confirmed": "[Pickket] 주문이 접수되었습니다",
    "view": "[Pickket] 주문 조회 링크",
    "refund": "[Pickket] 환불 요청 링크",
    "claim": "[Pickket] 회원 계정으로 주문 연동하기",
}


def build_guest_order_link(order_id: str, raw_token: str, *, locale: str = "ko") -> str:
    """게스트 재방문 매직링크 URL. consumer `/{locale}/guests/orders/{id}?token=<raw>`.

    token 은 1회성(single-use refund/claim) 또는 만료제한(view). CONSUMER_URL 은 env 로 주입.
    """
    base = (settings.CONSUMER_URL or "").rstrip("/")
    return f"{base}/{locale}/guests/orders/{order_id}?token={raw_token}"


async def send_guest_magic_link(
    *,
    to: str,
    purpose: str,
    order_id: str,
    raw_token: str,
    event_title: str | None = None,
    order_summary: str | None = None,
    locale: str = "ko",
) -> bool:
    """게스트 매직링크 이메일 발송(best-effort — 실패해도 예외 전파 안 함).

    purpose: "order_confirmed" | "view" | "refund" | "claim".
    반환: 발송 성공 True / 실패·예외 False(호출자는 트랜잭션을 깨지 않는다).
    """
    subject = _GUEST_MAGIC_SUBJECTS.get(purpose, _GUEST_MAGIC_SUBJECTS["view"])
    link = build_guest_order_link(order_id, raw_token, locale=locale)
    title_html = f"<p><b>{event_title}</b></p>" if event_title else ""
    summary_html = f"<p>{order_summary}</p>" if order_summary else ""

    if purpose == "order_confirmed":
        cta = "주문 상세 보기"
        lead = "주문이 정상 접수되었습니다. 아래 링크에서 주문 상세를 확인하세요."
    elif purpose == "refund":
        cta = "환불 진행하기"
        lead = "요청하신 환불 링크입니다. 아래 버튼을 눌러 환불을 진행하세요(1회용 링크)."
    elif purpose == "claim":
        cta = "회원 계정으로 연동하기"
        lead = (
            "로그인 후 아래 링크로 이 주문을 회원 계정에 연동할 수 있습니다"
            "(로그인 필요, 1회용 링크)."
        )
    else:  # view
        cta = "주문 조회하기"
        lead = "아래 링크에서 주문 상세를 확인하세요."

    html = (
        f"<p>{lead}</p>"
        f"{title_html}"
        f"{summary_html}"
        f'<p><a href="{link}">{cta}</a></p>'
        "<p>본 링크는 본인 확인용이며 타인에게 공유하지 마세요.</p>"
        "<p>감사합니다,<br>Pickket 팀</p>"
    )

    try:
        provider = get_email_provider()
        ok = await provider.send(to, subject, html)
        logger.info(
            "guest magic link email → to=%s purpose=%s order=%s ok=%s",
            mask_email(to), purpose, order_id, ok,
        )
        return bool(ok)
    except Exception:
        # 격리: 발송 실패는 주문/토큰 성공을 깨지 않는다. mask_email 로만 로깅.
        logger.warning(
            "guest magic link email failed (isolated) → to=%s purpose=%s order=%s",
            mask_email(to), purpose, order_id, exc_info=True,
        )
        return False
