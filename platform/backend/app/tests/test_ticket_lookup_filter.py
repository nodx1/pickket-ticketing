"""🔴 「내 티켓」에 죽은 표가 섞이면 안 된다 (2026-08-20 대회 중 실사고).

결제창에서 한 번이라도 시간이 초과되면 그 주문의 티켓이 `expired` 로 남는다.
종전 조회는 그것까지 내려보내, 재구매에 성공한 손님 화면에서 **유효한 표가 죽은 표에
묻혔다**. 손님은 위에 있는 걸 눌러 "만료" 를 보고 전화한다.

실측: 구매자 34명 · 죽은 표 100장. 대회 첫날 민원이 종일 들어왔다.
"""


def test_lookup_excludes_dead_tickets():
    """🔴 만료·취소는 목록에서 빠진다."""
    src = open("app/api/v1/internal_commerce_read.py", encoding="utf-8").read()
    i = src.index('@router.post("/public/ticket-lookup"')
    body = src[i : i + 4000]
    assert "TicketStatus.EXPIRED" in body, "만료 표가 그대로 나간다 — 손님이 잘못 누른다"
    assert "Ticket.status != TicketStatus.EXPIRED" in body


def test_lookup_keeps_used_tickets():
    """🔴 `used`(입장 완료)는 남는다 — 종일 입장이라 재입장·경품추첨에 계속 쓴다.

    ⚠️ 여기서 빼는 것은 **되살아나지 않는 두 상태**뿐이다. 넓게 자르면
       입장한 손님이 자기 표를 못 찾는다(그게 더 큰 사고다).
    """
    src = open("app/api/v1/internal_commerce_read.py", encoding="utf-8").read()
    i = src.index('@router.post("/public/ticket-lookup"')
    body = src[i : i + 4000]
    j = body.index("Ticket.status != TicketStatus.EXPIRED")
    clause = body[j : j + 200]
    assert "USED" not in clause, "입장한 손님이 자기 표를 못 본다"
    assert "TRANSFERRED" not in clause, "양도받은 표가 사라진다"
    assert "PENDING" not in clause, "발권 대기 표가 사라진다"
    # 🔴 환불받은 손님은 취소 표가 보여야 "환불됨"을 안다(실측 38명).
    assert "CANCELLED" not in clause, "환불 손님 화면이 텅 빈다"
