"""공정성 증명서 PDF (reportlab).

한글은 reportlab 내장 CID 글꼴(HYGothic-Medium, Adobe-Korea1)로 그린다 — 별도 글꼴 파일이 필요 없다.
검증 페이지 QR 을 함께 넣어 종이로 받아도 누구나 원본 대조를 할 수 있게 한다.
"""

from __future__ import annotations

import io
from datetime import datetime

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

FONT = "HYGothic-Medium"
_registered = False

INK = colors.HexColor("#1A1D2E")
MUTED = colors.HexColor("#5B6075")
LINE = colors.HexColor("#D9DCE6")
ACCENT = colors.HexColor("#6C5CE7")
OK = colors.HexColor("#059669")

ALGORITHM_LABEL = {
    "efraimidis_spirakis_weighted_sampling": "가중 공정 추첨 (Efraimidis–Spirakis 가중 비복원 추출)",
    "weighted_allocation_v1": "가중 배분 (가중 사회후생 극대화 · 2위 가격)",
}


def _ensure_font() -> None:
    global _registered
    if not _registered:
        pdfmetrics.registerFont(UnicodeCIDFont(FONT))
        _registered = True


def _fmt_time(value: str | None) -> str:
    if not value:
        return "-"
    try:
        dt = datetime.fromisoformat(value)
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    except ValueError:
        return value


def _wrap_hex(value: str | None, width: int = 32) -> list[str]:
    if not value:
        return ["-"]
    return [value[i : i + width] for i in range(0, len(value), width)]


def render_certificate_pdf(view: dict) -> bytes:
    _ensure_font()
    p = view["payload"]
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(f"공정성 증명서 {view['cert_no']}")
    c.setAuthor("Pickket")
    width, height = A4
    left = 20 * mm
    right = width - 20 * mm
    y = height - 25 * mm

    c.setFillColor(ACCENT)
    c.rect(0, height - 8 * mm, width, 8 * mm, stroke=0, fill=1)

    c.setFillColor(INK)
    c.setFont(FONT, 22)
    c.drawString(left, y, "추첨 공정성 증명서")
    c.setFont(FONT, 10)
    c.setFillColor(MUTED)
    c.drawRightString(right, y + 6, f"발급번호  {view['cert_no']}")
    c.drawRightString(right, y - 8, f"발급일시  {_fmt_time(view.get('issued_at'))}")
    y -= 14 * mm

    c.setFillColor(INK)
    c.setFont(FONT, 12)
    c.drawString(left, y, f"{p['event']['title']}  ·  {p['tier']['name']}")
    y -= 6 * mm
    c.setFont(FONT, 9.5)
    c.setFillColor(MUTED)
    c.drawString(left, y, ALGORITHM_LABEL.get(p.get("algorithm", ""), p.get("algorithm", "")))
    y -= 9 * mm

    counts = p.get("counts", {})
    boxes = [
        ("응모", counts.get("applicants", 0)),
        ("좌석", counts.get("capacity", 0)),
        ("당첨", counts.get("winners", 0)),
        ("대기", counts.get("waitlisted", 0)),
        ("제재 제외", counts.get("excluded_by_sanction", 0)),
    ]
    box_w = (right - left - 4 * 4 * mm) / 5
    for i, (label, value) in enumerate(boxes):
        x = left + i * (box_w + 4 * mm)
        c.setStrokeColor(LINE)
        c.roundRect(x, y - 14 * mm, box_w, 14 * mm, 2 * mm, stroke=1, fill=0)
        c.setFillColor(MUTED)
        c.setFont(FONT, 8)
        c.drawString(x + 3 * mm, y - 5 * mm, label)
        c.setFillColor(INK)
        c.setFont(FONT, 14)
        c.drawString(x + 3 * mm, y - 11.5 * mm, f"{value:,}")
    y -= 22 * mm

    def section(title: str) -> None:
        nonlocal y
        c.setFillColor(INK)
        c.setFont(FONT, 11)
        c.drawString(left, y, title)
        y -= 2.5 * mm
        c.setStrokeColor(LINE)
        c.line(left, y, right, y)
        y -= 5.5 * mm

    def row(label: str, value: str | list[str], mono: bool = False) -> None:
        nonlocal y
        lines = value if isinstance(value, list) else [value]
        c.setFillColor(MUTED)
        c.setFont(FONT, 8.5)
        c.drawString(left, y, label)
        c.setFillColor(INK)
        for line in lines:
            if mono:
                c.setFont("Courier", 8.5)
            else:
                c.setFont(FONT, 9)
            c.drawString(left + 42 * mm, y, line)
            y -= 4.6 * mm
        y -= 1.2 * mm

    section("진행 순서 (각 단계가 앞 단계보다 늦게 기록됨)")
    row("① 가중치 정책 고정", _fmt_time(p.get("policy_locked_at")))
    row("② 추첨 시드 사전 커밋", _fmt_time(p.get("committed_at")))
    row("③ 응모 명단 루트 확정", _fmt_time(p.get("entries_root_at")))
    row("④ 추첨 실행·시드 공개", _fmt_time(p.get("drawn_at")))
    y -= 2 * mm

    section("무결성 값")
    row("정책 해시", _wrap_hex(p.get("policy_hash"), 64), mono=True)
    row("시드 커밋", _wrap_hex(p.get("seed_commitment"), 64), mono=True)
    row("공개 시드", p.get("server_seed") or "-", mono=True)
    row("응모 Merkle 루트", _wrap_hex(p.get("entries_root"), 64), mono=True)
    row("결과 Merkle 루트", _wrap_hex(p.get("results_root"), 64), mono=True)
    row("결과 바인딩 해시", _wrap_hex(p.get("result_hash"), 64), mono=True)
    y -= 2 * mm

    section("전자 서명")
    row("서명 방식", f"{view.get('signature_algorithm', 'Ed25519')}  (키 ID {view.get('key_id')})")
    row("내용 해시", _wrap_hex(view.get("payload_hash"), 64), mono=True)
    row("서명", _wrap_hex(view.get("signature"), 64), mono=True)

    checks = view.get("checks", {})
    y -= 2 * mm
    c.setFont(FONT, 9.5)
    c.setFillColor(OK if checks.get("all_valid") else colors.HexColor("#EF4444"))
    c.drawString(
        left,
        y,
        "발급 시점 자체 검증: 서명·루트·순서 모두 일치" if checks.get("all_valid") else "자체 검증 불일치 — 발급처에 문의",
    )

    # QR + 안내
    qr_size = 32 * mm
    widget = QrCodeWidget(p.get("verify_url", ""))
    bounds = widget.getBounds()
    d = Drawing(qr_size, qr_size, transform=[qr_size / (bounds[2] - bounds[0]), 0, 0, qr_size / (bounds[3] - bounds[1]), 0, 0])
    d.add(widget)
    renderPDF.draw(d, c, right - qr_size, 18 * mm)
    c.setFillColor(MUTED)
    c.setFont(FONT, 8)
    guide = [
        "이 증명서는 추첨 결과를 사후에 바꿀 수 없었음을 보여 줍니다.",
        "· 응모 명단은 추첨 전에 Merkle 루트로 고정되었습니다.",
        "· 추첨 시드는 응모 시작 시점에 해시로 먼저 공개되었습니다.",
        "· 응모자는 검증 페이지에서 내 응모가 루트에 포함됐는지 직접 확인할 수 있습니다.",
        f"검증 페이지: {p.get('verify_url', '')}",
    ]
    gy = 18 * mm + qr_size - 4 * mm
    for line in guide:
        c.drawString(left, gy, line)
        gy -= 4.6 * mm

    c.showPage()
    c.save()
    return buf.getvalue()
