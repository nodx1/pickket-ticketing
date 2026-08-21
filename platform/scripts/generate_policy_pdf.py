"""
Pickket 판매모드 & AP 통합 정책서 v3 — PDF 생성
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.units import mm, cm
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
import os

# ─── 폰트 등록 ───
pdfmetrics.registerFont(TTFont('NotoSans', '/tmp/pretendard/public/static/alternative/Pretendard-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSans-Bold', '/tmp/pretendard/public/static/alternative/Pretendard-Bold.ttf'))

# ─── 색상 ───
C_PRIMARY = HexColor('#6c5ce7')
C_PRIMARY_LIGHT = HexColor('#f0eeff')
C_EMERALD = HexColor('#10b981')
C_BLUE = HexColor('#3b82f6')
C_AMBER = HexColor('#f59e0b')
C_PURPLE = HexColor('#8b5cf6')
C_DARK = HexColor('#1e293b')
C_GRAY = HexColor('#64748b')
C_LIGHTGRAY = HexColor('#f1f5f9')
C_WHITE = white
C_RED = HexColor('#ef4444')
C_GREEN = HexColor('#22c55e')

# ─── 스타일 ───
styles = getSampleStyleSheet()

S_TITLE = ParagraphStyle('S_TITLE', parent=styles['Title'],
    fontName='NotoSans-Bold', fontSize=22, leading=28,
    textColor=C_DARK, spaceAfter=4*mm, alignment=TA_LEFT)

S_SUBTITLE = ParagraphStyle('S_SUBTITLE', parent=styles['Normal'],
    fontName='NotoSans', fontSize=11, leading=14,
    textColor=C_GRAY, spaceAfter=8*mm)

S_H1 = ParagraphStyle('S_H1', parent=styles['Heading1'],
    fontName='NotoSans-Bold', fontSize=16, leading=22,
    textColor=C_PRIMARY, spaceBefore=10*mm, spaceAfter=4*mm,
    borderWidth=0, borderPadding=0)

S_H2 = ParagraphStyle('S_H2', parent=styles['Heading2'],
    fontName='NotoSans-Bold', fontSize=13, leading=18,
    textColor=C_DARK, spaceBefore=6*mm, spaceAfter=3*mm)

S_H3 = ParagraphStyle('S_H3', parent=styles['Heading3'],
    fontName='NotoSans-Bold', fontSize=11, leading=15,
    textColor=C_GRAY, spaceBefore=4*mm, spaceAfter=2*mm)

S_BODY = ParagraphStyle('S_BODY', parent=styles['Normal'],
    fontName='NotoSans', fontSize=9.5, leading=14,
    textColor=C_DARK, spaceAfter=2*mm)

S_BODY_BOLD = ParagraphStyle('S_BODY_BOLD', parent=S_BODY,
    fontName='NotoSans-Bold')

S_QUOTE = ParagraphStyle('S_QUOTE', parent=S_BODY,
    fontName='NotoSans-Bold', fontSize=10, leading=15,
    textColor=C_PRIMARY, leftIndent=10*mm, rightIndent=10*mm,
    spaceBefore=3*mm, spaceAfter=3*mm,
    borderWidth=0, borderPadding=6, borderColor=C_PRIMARY,
    backColor=C_PRIMARY_LIGHT)

S_SMALL = ParagraphStyle('S_SMALL', parent=S_BODY,
    fontSize=8, leading=11, textColor=C_GRAY)

S_TABLE_HEADER = ParagraphStyle('S_TH', parent=S_BODY,
    fontName='NotoSans-Bold', fontSize=8.5, leading=12,
    textColor=C_WHITE, alignment=TA_CENTER)

S_TABLE_CELL = ParagraphStyle('S_TC', parent=S_BODY,
    fontSize=8.5, leading=12, alignment=TA_CENTER)

S_TABLE_CELL_L = ParagraphStyle('S_TCL', parent=S_TABLE_CELL,
    alignment=TA_LEFT)

S_TABLE_CELL_R = ParagraphStyle('S_TCR', parent=S_TABLE_CELL,
    alignment=TA_RIGHT)


def make_table(headers, rows, col_widths=None, header_color=C_PRIMARY):
    """표 생성 헬퍼"""
    header_row = [Paragraph(h, S_TABLE_HEADER) for h in headers]
    data = [header_row]
    for row in rows:
        data.append([Paragraph(str(c), S_TABLE_CELL) for c in row])

    w = col_widths or [None] * len(headers)
    t = Table(data, colWidths=w, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), header_color),
        ('TEXTCOLOR', (0, 0), (-1, 0), C_WHITE),
        ('FONTNAME', (0, 0), (-1, 0), 'NotoSans-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 8.5),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [C_WHITE, C_LIGHTGRAY]),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]))
    return t


def make_table_left_first(headers, rows, col_widths=None, header_color=C_PRIMARY):
    """첫 열 좌측 정렬 표"""
    header_row = [Paragraph(h, S_TABLE_HEADER) for h in headers]
    data = [header_row]
    for row in rows:
        cells = []
        for i, c in enumerate(row):
            style = S_TABLE_CELL_L if i == 0 else S_TABLE_CELL
            cells.append(Paragraph(str(c), style))
        data.append(cells)

    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), header_color),
        ('TEXTCOLOR', (0, 0), (-1, 0), C_WHITE),
        ('FONTNAME', (0, 0), (-1, 0), 'NotoSans-Bold'),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('ALIGN', (0, 1), (0, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [C_WHITE, C_LIGHTGRAY]),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]))
    return t


def hr():
    return HRFlowable(width="100%", thickness=0.5, color=HexColor('#e2e8f0'),
                      spaceBefore=4*mm, spaceAfter=4*mm)


class FooterCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        canvas.Canvas.__init__(self, *args, **kwargs)
        self.pages = []

    def showPage(self):
        self.pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self.pages)
        for i, page in enumerate(self.pages):
            self.__dict__.update(page)
            self._draw_footer(i + 1, num_pages)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    def _draw_footer(self, page_num, total):
        self.saveState()
        self.setFont('NotoSans', 7)
        self.setFillColor(C_GRAY)
        w, h = A4
        self.drawString(20*mm, 10*mm, "Pickket 판매모드 & AP 통합 정책서 v3.0 | CONFIDENTIAL")
        self.drawRightString(w - 20*mm, 10*mm, f"{page_num} / {total}")
        # Top line
        self.setStrokeColor(C_PRIMARY)
        self.setLineWidth(2)
        self.line(20*mm, h - 12*mm, w - 20*mm, h - 12*mm)
        self.restoreState()


def build_pdf():
    output_path = os.path.expanduser("~/Desktop/pickket.v2/docs/architecture/SALE_MODE_POLICY_v3_FINAL.pdf")
    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=20*mm, rightMargin=20*mm,
        topMargin=18*mm, bottomMargin=18*mm
    )

    story = []
    W = doc.width  # usable width

    # ═══════════════════════════════════════════════
    # 표지
    # ═══════════════════════════════════════════════
    story.append(Spacer(1, 30*mm))
    story.append(Paragraph("PICKKET", ParagraphStyle('logo',
        fontName='NotoSans-Bold', fontSize=14, textColor=C_PRIMARY,
        spaceAfter=6*mm, alignment=TA_LEFT)))
    story.append(Paragraph("판매모드 & AP 통합 정책서", S_TITLE))
    story.append(Paragraph("Version 3.0 — CEO 확정", ParagraphStyle('ver',
        fontName='NotoSans-Bold', fontSize=13, textColor=C_EMERALD,
        spaceAfter=10*mm)))
    story.append(hr())

    # 메타 테이블
    meta_data = [
        ["작성일", "2026-04-10"],
        ["결정자", "CEO"],
        ["상태", "확정"],
        ["대체 문서", "SALE_MODE_POLICY_2026-03-12.md + AP_POINT_POLICY.md"],
        ["검증 스크립트", "sale_mode_simulation.py, lottery_v2_simulation.py, sale_mode_final_simulation.py"],
    ]
    meta_table = Table(
        [[Paragraph(r[0], S_BODY_BOLD), Paragraph(r[1], S_BODY)] for r in meta_data],
        colWidths=[35*mm, W - 35*mm]
    )
    meta_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 10*mm))

    # 한 줄 요약
    story.append(Paragraph(
        "AP는 활동하면 쌓이는 돈(1AP=1원). 추첨에 쓰면 당첨 확률 UP(소비됨), 안 쓰면 수수료 할인. 1년 후 소멸.",
        S_QUOTE))

    story.append(Spacer(1, 15*mm))

    # 목차
    story.append(Paragraph("목차", S_H2))
    toc_items = [
        "1. 전체 구조",
        "2. AP(마일리지) 시스템",
        "3. 공정 추첨 설계",
        "4. 판매모드 4종",
        "5. 주최자 조합 가이드",
        "6. 플랫폼 경제",
        "7. 공정성 검증 결과",
        "8. 코드 변경 사항",
        "9. 용어 통일",
        "10. 글로벌 정합성",
        "11. 후속 작업",
    ]
    for item in toc_items:
        story.append(Paragraph(item, ParagraphStyle('toc',
            fontName='NotoSans', fontSize=10, leading=16,
            textColor=C_DARK, leftIndent=5*mm)))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 1. 전체 구조
    # ═══════════════════════════════════════════════
    story.append(Paragraph("1. 전체 구조", S_H1))

    struct_data = [
        ["구성", "항목", "설명"],
        ["판매모드 4종", "1 멤버십 선판매", "팬클럽/멤버십 회원 대상 우선 추첨"],
        ["", "2 공정 추첨", "AP 가중치 추첨 (투입 AP 소비됨)"],
        ["", "3 대기열 판매", "랜덤 순번 배정 (Glastonbury 모델)"],
        ["", "4 잔여 선착순", "이전 단계 잔여석만, 항상 마지막"],
        ["횡단 메커니즘", "5 액면가 대기", "취소 티켓 → 액면가 재배정 (DICE 모델)"],
        ["AP 시스템", "용도 A: 추첨 투입", "로그 스케일, 소비됨"],
        ["", "용도 B: 수수료 할인", "1AP=1원, 최대 70% OFF"],
        ["", "소멸", "12개월 절대 소멸"],
        ["수수료", "예매 수수료", "2,000원 (올인가격 포함)"],
    ]
    t = Table(
        [[Paragraph(c, S_TABLE_HEADER if i == 0 else (S_TABLE_CELL_L if j == 0 else S_TABLE_CELL))
          for j, c in enumerate(row)]
         for i, row in enumerate(struct_data)],
        colWidths=[30*mm, 35*mm, W - 65*mm], repeatRows=1
    )
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), C_PRIMARY),
        ('TEXTCOLOR', (0, 0), (-1, 0), C_WHITE),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [C_WHITE, C_LIGHTGRAY]),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('SPAN', (0, 1), (0, 4)),  # 판매모드 4종
        ('SPAN', (0, 5), (0, 5)),  # 횡단
        ('SPAN', (0, 6), (0, 8)),  # AP
    ]))
    story.append(t)

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 2. AP 시스템
    # ═══════════════════════════════════════════════
    story.append(Paragraph("2. AP(마일리지) 시스템", S_H1))

    story.append(Paragraph("2-1. AP가 뭔가", S_H2))
    ap_points = [
        "피켓에서 활동하면 쌓이는 포인트. 1 AP = 1원 체감.",
        "돈으로 못 산다. 오직 활동으로만 적립.",
        "용도 A: 추첨 투입 - 당첨 확률 UP (투입 AP는 당첨/낙첨 무관 소비됨)",
        "용도 B: 수수료 할인 - 확정 혜택 (1AP = 1원 차감, 최대 70%)",
        "적립일 기준 12개월 후 자동 소멸. 쌓아두면 손해, 쓰는 게 이득.",
    ]
    for p in ap_points:
        story.append(Paragraph(f"  {p}", S_BODY))

    story.append(Paragraph("2-2. 적립 테이블", S_H2))

    story.append(Paragraph("가입 즉시", S_H3))
    story.append(make_table_left_first(
        ["활동", "AP", "누적", "유저 체감"],
        [
            ["회원가입", "500", "500", '"가입만 해도 500원"'],
            ["프로필 완성 (사진+소개)", "200", "700", '"프로필 채우면 700원 할인"'],
        ],
        col_widths=[40*mm, 15*mm, 15*mm, W - 70*mm]
    ))

    story.append(Spacer(1, 3*mm))
    story.append(Paragraph("일상 활동", S_H3))
    story.append(make_table_left_first(
        ["활동", "AP", "빈도", "유저 체감"],
        [
            ["앱 출석", "10/일", "매일", '"매일 들어오면 10원"'],
            ["주간 출석 보너스 (3일+)", "70~150/주", "주 1회", '"주 5일 출석 = 100원"'],
            ["SNS 공유", "20", "이벤트당 1회", '"공유하면 20원"'],
            ["친구 초대 (가입 완료)", "200", "월 5건", '"친구 데려오면 200원"'],
        ],
        col_widths=[42*mm, 22*mm, 22*mm, W - 86*mm]
    ))

    story.append(Spacer(1, 3*mm))
    story.append(Paragraph("공연 연계", S_H3))
    story.append(make_table_left_first(
        ["활동", "AP", "빈도", "유저 체감"],
        [
            ["공연 관람 완료 (QR 입장)", "150", "공연당", '"보고 오면 150원"'],
            ["후기 (텍스트, 50자+)", "80", "공연당", '"후기 쓰면 80원"'],
            ["후기 (사진 포함)", "120", "공연당", '"사진 후기 120원"'],
            ["티켓 구매 완료", "200", "월 5건", '"구매하면 200원"'],
            ["첫 구매 달성", "300", "1회", '"첫 구매 보너스 300원"'],
        ],
        col_widths=[42*mm, 22*mm, 22*mm, W - 86*mm]
    ))

    story.append(Spacer(1, 3*mm))
    story.append(Paragraph("팬 활동", S_H3))
    story.append(make_table_left_first(
        ["활동", "AP", "빈도"],
        [
            ["팬클럽 가입 인증 (공식)", "1,000", "팬클럽당 1회"],
            ["팬클럽 연회비 갱신", "500", "연 1회"],
            ["장르 서포터 달성 (동일 도메인 3회)", "500", "도메인당 1회"],
        ],
        col_widths=[50*mm, 20*mm, W - 70*mm]
    ))

    story.append(Paragraph("2-3. 유저 시나리오별 예상 적립", S_H2))
    story.append(make_table_left_first(
        ["유저 유형", "월 적립", "연 적립", "수수료 체감 (2,000원)", "추첨 사용 시"],
        [
            ["신규 (가입 첫 달)", "~1,500", "-", "700AP -> 1,300원 결제", "추첨 1회 투입 가능"],
            ["라이트 (주 1~2일)", "~300", "~3,600", "300원 할인 -> 1,700원", "추첨 1회/월"],
            ["일반 (주 3일)", "~600", "~7,200", "600원 할인 -> 1,400원", "추첨 or 할인 택 1"],
            ["열성 (주 5일)", "~1,100", "~13,200", "1,100원 할인 -> 900원", "추첨 + 잔여 할인"],
            ["고래 (매일)", "~2,000", "~24,000", "최대 할인 -> 600원", "추첨 풀투입 + 할인"],
        ],
        col_widths=[30*mm, 18*mm, 18*mm, 42*mm, W - 108*mm]
    ))

    story.append(Paragraph("2-4. AP 이중 용도", S_H2))

    story.append(Paragraph("용도 A: 공정 추첨 투입", S_H3))
    a_points = [
        "응모 시 원하는 만큼 AP 투입 (0~3,000 AP 상한)",
        "많이 넣을수록 당첨 확률 UP - 단, 로그 스케일 (3-3 참고)",
        "투입 AP는 당첨/낙첨 무관하게 소비됨 (환급 없음)",
        "0 AP로도 응모 가능 (기본 당첨 확률 보장)",
    ]
    for p in a_points:
        story.append(Paragraph(f"  {p}", S_BODY))

    story.append(Paragraph(
        "왜 환급 없는가: AP를 '진짜 자원'으로 만든다. 환급하면 AP가 무한 재활용되어 화폐 가치 붕괴. "
        "소비되어야 유저가 '추첨에 걸까 vs 수수료 할인에 쓸까' 진짜 선택을 한다.",
        S_QUOTE))

    story.append(Paragraph("용도 B: 예매 수수료 할인", S_H3))
    b_points = [
        "예매 시 보유 AP로 수수료 차감. 1 AP = 1원.",
        "예매 수수료: 2,000원 (신규 플랫폼 적정가, 업계 하단~중단)",
        "AP 할인 상한: 70% (최대 1,400원 할인) -> 최소 실결제 600원",
        "P1 정직가격: 수수료는 표시 가격에 포함 (올인 가격). AP 할인은 결제 시 차감.",
    ]
    for p in b_points:
        story.append(Paragraph(f"  {p}", S_BODY))

    story.append(Spacer(1, 3*mm))
    story.append(Paragraph("업계 수수료 비교", S_H3))
    story.append(make_table_left_first(
        ["플랫폼", "수수료", "할인", "비고"],
        [
            ["멜론티켓", "4,000원", "없음", "업계 최고"],
            ["인터파크(NOL)", "2,000~4,000원", "없음", "장르별"],
            ["티켓링크", "1,000~2,000원", "없음", "2024년 인상"],
            ["YES24", "1,000~3,000원", "없음", "공연별 상이"],
            ["피켓", "2,000원", "최대 70% OFF", "AP 활동 보상"],
        ],
        col_widths=[32*mm, 30*mm, 25*mm, W - 87*mm]
    ))

    story.append(Spacer(1, 3*mm))
    story.append(Paragraph("소비자 체감 (멜론에서 전환 시)", S_H3))
    story.append(make_table_left_first(
        ["단계", "보유 AP", "할인", "실결제", "vs 멜론 4,000원"],
        [
            ["가입 직후", "0", "0원", "2,000원", "50% 절감"],
            ["가입+프로필", "700", "700원", "1,300원", "68% 절감"],
            ["1달 활동 (일반)", "600", "600원", "1,400원", "65% 절감"],
            ["1달 활동 (열성)", "1,100", "1,100원", "900원", "78% 절감"],
            ["MAX 할인", "1,400+", "1,400원", "600원", "85% 절감"],
        ],
        col_widths=[28*mm, 20*mm, 18*mm, 20*mm, W - 86*mm]
    ))

    story.append(Paragraph("2-5. AP 소멸 정책", S_H2))
    story.append(make_table_left_first(
        ["항목", "규칙"],
        [
            ["소멸 기준", "적립일로부터 12개월 경과 시 자동 소멸"],
            ["활동 리셋", "없음. 각 AP가 개별 만료일 보유"],
            ["FIFO 소비", "수수료 할인/추첨 투입 시 만료 임박 AP부터 소비"],
            ["추첨 투입", "당첨/낙첨 무관하게 소비됨 (환급 없음)"],
            ["소멸 예고", "적립 10개월 시 알림, 매월 1일 소멸 예정 푸시"],
            ["소멸 직전 CTA", '소멸 2주 전 "소멸 전에 쓰세요" 유도'],
        ],
        col_widths=[30*mm, W - 30*mm]
    ))

    story.append(Spacer(1, 3*mm))
    story.append(Paragraph("2-6. AP 현금 구매 절대 불가 (P4 보호)", S_H2))
    story.append(Paragraph("  어떠한 경우에도 현금 -> AP 전환 금지. 위반 시 AP 전액 몰수 + 30일 정지.", S_BODY))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 3. 공정 추첨 설계
    # ═══════════════════════════════════════════════
    story.append(Paragraph("3. 공정 추첨 설계", S_H1))

    story.append(Paragraph(
        "AP는 당첨 확률을 약간 올려주는 보너스. 결과를 지배하면 안 된다.", S_QUOTE))

    story.append(Paragraph("3-1. 검증 목표치", S_H2))
    goals = [
        "고래 vs 라이트 당첨 확률 격차: 최대 1.3배 (시뮬 실측 1.26배)",
        "5회 연속 낙첨 유저: 다음 응모에서 고래보다 유리",
        "모든 세그먼트: 50회 내 미당첨 0%",
        "동일 아티스트 3회 연속 당첨: 사실상 불가",
    ]
    for g in goals:
        story.append(Paragraph(f"  {g}", S_BODY))

    story.append(Paragraph("3-2. 당첨 가중치 공식", S_H2))
    story.append(Paragraph(
        "당첨가중치 = 기본값(100) + log2(투입AP + 1) x 15 + 연속낙첨 보너스 + 신규부스트 - 쿨다운",
        ParagraphStyle('formula', parent=S_BODY, fontName='NotoSans-Bold',
                       fontSize=10, textColor=C_DARK, alignment=TA_CENTER,
                       spaceBefore=3*mm, spaceAfter=3*mm,
                       backColor=C_LIGHTGRAY, borderPadding=8)))

    story.append(Paragraph("3-3. AP 보너스 (로그 스케일)", S_H2))
    story.append(make_table(
        ["투입 AP", "AP보너스", "기본값 포함", "고래(2000) 대비"],
        [
            ["0", "0", "100", "0.66x"],
            ["300", "124", "224", "0.87x"],
            ["600", "139", "239", "0.93x"],
            ["1,200", "154", "254", "0.98x"],
            ["2,000", "164", "264", "기준"],
            ["3,000+", "173", "273", "상한"],
        ],
        col_widths=[30*mm, 30*mm, 30*mm, W - 90*mm]
    ))
    story.append(Paragraph("  핵심: 0 AP vs 2,000 AP = 1.5배. 300 vs 2,000 = 1.15배. 활동 보상은 있되 독식 불가.", S_SMALL))

    story.append(Paragraph("3-4. 연속 낙첨 부스트", S_H2))
    story.append(make_table(
        ["연속 낙첨", "추가 가중치", "효과"],
        [
            ["1회", "0", "기본"],
            ["2연속", "+30", "약간 유리"],
            ["3연속", "+70", "눈에 띄게 유리"],
            ["4연속", "+100", "상당히 유리"],
            ["5연속+", "+150", "고래보다 유리 (역전)"],
        ],
        col_widths=[25*mm, 25*mm, W - 50*mm]
    ))

    story.append(Paragraph("3-5. 신규 가입 부스트", S_H2))
    story.append(Paragraph("  가입 후 90일간 기본값 100 -> 130 (+30%). 첫 당첨 달성 시 즉시 종료.", S_BODY))
    story.append(Paragraph("  시뮬 결과: 신규 유저 당첨률 7.5% (고래 7.3%와 대등)", S_SMALL))

    story.append(Paragraph("3-6. 쿨다운 (독식 방지)", S_H2))
    story.append(make_table_left_first(
        ["조건", "가중치 감소"],
        [
            ["30일 내 동일 아티스트 당첨", "-50%"],
            ["30일 내 동일 장르 당첨", "-20%"],
            ["60일 내 2회 이상 당첨", "-30%"],
            ["중첩 하한", "최소 50%"],
        ],
        col_widths=[55*mm, W - 55*mm]
    ))
    story.append(Paragraph("  시뮬 결과: 고유 당첨자 292명 -> 3,003명 (10배 확산)", S_SMALL))

    story.append(Paragraph("3-7. 추첨 운영 규칙", S_H2))
    story.append(make_table_left_first(
        ["항목", "규칙"],
        [
            ["응모 기간", "7~14일 (주최자 설정)"],
            ["신청 시점", "당첨 확률에 무관"],
            ["투입 AP", "0~3,000 자유 선택"],
            ["AP 소비", "당첨/낙첨 무관하게 전액 소비"],
            ["인당 한도", "최대 2매"],
            ["중복 응모", "동일 이벤트 재응모 시 전건 실격"],
            ["결제 기한", "당첨 후 72시간"],
        ],
        col_widths=[30*mm, W - 30*mm]
    ))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 4. 판매모드 4종
    # ═══════════════════════════════════════════════
    story.append(Paragraph("4. 판매모드 4종", S_H1))

    story.append(Paragraph("단계 흐름: SETUP -> [MEMBERSHIP] -> [LOTTERY] -> [QUEUE] -> [FCFS] -> CLOSED", S_BODY_BOLD))
    story.append(Paragraph("  주최자가 1~4개 선택 조합. 모든 단계에 WAITLIST 횡단 적용. 미소화 좌석 자동 이월.", S_SMALL))
    story.append(Spacer(1, 3*mm))

    modes = [
        ("1 멤버십 선판매", "membership_presale", C_EMERALD, [
            ["대상", "유료 멤버십/팬클럽/서포터즈 회원"],
            ["방식", "응모 기간(5~14일) -> 추첨 (시점 무관)"],
            ["한도", "1인 2매, 동반자 사전등록"],
            ["AP", "투입 가능 (선택, 소비됨)"],
            ["참고", "일본 FC先行과 1:1 매핑"],
        ]),
        ("2 공정 추첨", "lottery", C_PURPLE, [
            ["대상", "전체 회원 (멤버십 불요)"],
            ["방식", "응모 기간(7~14일) -> AP 가중치 추첨"],
            ["AP", "3 공정 추첨 공식 적용. 투입 AP 소비됨"],
            ["한도", "1인 2매, 중복 응모 시 전건 실격"],
            ["참고", "일본 一般抽選 + Pickket AP 가중치"],
        ]),
        ("3 대기열 판매", "queue_sale", C_BLUE, [
            ["대상", "전체 회원"],
            ["방식", "오픈 시간 접속 -> 랜덤 순번 배정 -> 좌석 선택"],
            ["시간 제한", "좌석 선택 10분 + 결제 7분"],
            ["AP", "수수료 할인에만 사용 (순번 영향 없음)"],
            ["참고", "Glastonbury 2025 랜덤 큐 모델"],
        ]),
        ("4 잔여 선착순", "fcfs_residual", C_AMBER, [
            ["대상", "전체 (비회원 포함 가능)"],
            ["방식", "순수 선착순, 이전 단계 잔여석만"],
            ["위치", "항상 마지막 단계"],
            ["AP", "수수료 할인에만 사용"],
            ["참고", "일본 一般発売 (잔여 소화)"],
        ]),
    ]

    for name, code, color, rows in modes:
        story.append(Paragraph(f"{name} ({code})", ParagraphStyle('mode_h',
            fontName='NotoSans-Bold', fontSize=11, leading=15,
            textColor=color, spaceBefore=5*mm, spaceAfter=2*mm)))
        t = Table(
            [[Paragraph(r[0], S_BODY_BOLD), Paragraph(r[1], S_BODY)] for r in rows],
            colWidths=[30*mm, W - 30*mm]
        )
        t.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('LINEBELOW', (0, -1), (-1, -1), 0.5, HexColor('#e2e8f0')),
        ]))
        story.append(t)

    story.append(Spacer(1, 4*mm))
    story.append(Paragraph("5 액면가 대기 (WAITLIST) - 횡단 메커니즘", ParagraphStyle('mode_h',
        fontName='NotoSans-Bold', fontSize=11, textColor=C_RED, spaceAfter=2*mm)))
    story.append(Paragraph("  모든 판매모드에 자동 적용. 매진 후 대기 등록 -> 취소 시 팬 가중치 순 자동 오퍼(10분). 항상 액면가.", S_BODY))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 5. 주최자 조합 가이드
    # ═══════════════════════════════════════════════
    story.append(Paragraph("5. 주최자 조합 가이드", S_H1))

    story.append(Paragraph("5-1. 추천 조합", S_H2))
    story.append(make_table_left_first(
        ["공연 유형", "수요", "추천 조합", "좌석 할당"],
        [
            ["K-pop 대형", "20:1", "MEMBERSHIP -> LOTTERY", "40:60"],
            ["K-pop 중형", "5:1", "MEMBERSHIP -> LOTTERY -> QUEUE", "30:40:30"],
            ["뮤지컬/연극", "2:1", "LOTTERY -> QUEUE", "60:40"],
            ["소형/인디", "1.5:1", "QUEUE 단독", "100"],
            ["스포츠 시즌권", "8:1", "MEMBERSHIP -> QUEUE -> FCFS", "50:30:20"],
            ["페스티벌", "3:1", "LOTTERY 단독", "100"],
            ["팬미팅", "10:1", "MEMBERSHIP 단독", "100"],
        ],
        col_widths=[30*mm, 15*mm, 55*mm, W - 100*mm]
    ))

    story.append(Paragraph("5-2. 모드별 종합 점수", S_H2))
    story.append(make_table(
        ["모드", "매진율", "봇차단", "공정성", "운영 부하"],
        [
            ["멤버십 선판매", "100%", "95", "82", "낮음"],
            ["공정 추첨", "100%", "95", "90", "낮음"],
            ["대기열 판매", "100%", "80", "85", "중간"],
            ["잔여 선착순", "가변", "50", "55", "높음"],
        ],
        col_widths=[30*mm, 22*mm, 22*mm, 22*mm, W - 96*mm]
    ))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 6. 플랫폼 경제
    # ═══════════════════════════════════════════════
    story.append(Paragraph("6. 플랫폼 경제", S_H1))

    story.append(Paragraph("6-1. 수수료 경제 (시뮬 검증)", S_H2))
    story.append(make_table_left_first(
        ["지표", "값"],
        [
            ["예매 수수료", "2,000원 (P1 올인가격 포함)"],
            ["AP 할인 상한", "70% (최대 1,400원)"],
            ["최소 실결제", "600원/건"],
            ["건당 실질 수수료 (시뮬)", "668원"],
            ["할인율 (시뮬)", "66.6%"],
            ["연간 수수료 수입 (10K 유저)", "19.9M원"],
            ["유저 연간 절약 총액", "39.8M원"],
        ],
        col_widths=[50*mm, W - 50*mm]
    ))

    story.append(Paragraph("6-2. 세그먼트별 수수료 부담", S_H2))
    story.append(make_table_left_first(
        ["세그먼트", "연간 납부", "연간 할인", "실효 단가"],
        [
            ["고래 (1%)", "785K원", "1,695K원", "~633원"],
            ["열성 (9%)", "5,986K원", "10,826K원", "~712원"],
            ["일반 (50%)", "8,734K원", "18,432K원", "~643원"],
            ["라이트 (30%)", "2,780K원", "4,984K원", "~716원"],
            ["신규 (10%)", "1,648K원", "3,836K원", "~601원"],
        ],
        col_widths=[28*mm, 30*mm, 30*mm, W - 88*mm]
    ))

    story.append(Paragraph("6-3. AP 경제", S_H2))
    story.append(make_table_left_first(
        ["지표", "값"],
        [
            ["연간 총 AP 적립", "111.8M AP"],
            ["연간 AP 소멸", "33.5M AP (30%)"],
            ["AP -> 수수료 할인 소비", "39.8M AP"],
            ["AP -> 추첨 투입 소비", "~38.5M AP"],
            ["AP 순환율", "~70%"],
        ],
        col_widths=[45*mm, W - 45*mm]
    ))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 7. 공정성 검증 결과
    # ═══════════════════════════════════════════════
    story.append(Paragraph("7. 공정성 검증 결과", S_H1))

    story.append(Paragraph("7-1. 종합 지표 (v1 vs v3)", S_H2))
    story.append(make_table(
        ["지표", "v1 (선형, 1K)", "v3 (로그, 2K)", "판정"],
        [
            ["지니계수", "0.8397", "0.3905", "대폭 개선"],
            ["세그먼트 당첨률 격차", "4.8배", "1.26배", "거의 균등"],
            ["3회+ 독식자", "42명", "9명", "-79%"],
            ["고유 당첨자 수", "292명", "3,003명", "10배 확산"],
            ["50회 내 미당첨", "존재", "0%", "전원 보장"],
            ["봇 당첨 (대기열)", "10.0배", "1.0배", "완전 차단"],
            ["신규 vs 고래", "30:70", "48:52", "대등"],
            ["응모 후 0회 당첨", "-", "0.6%", "거의 없음"],
        ],
        col_widths=[35*mm, 28*mm, 28*mm, W - 91*mm]
    ))

    story.append(Paragraph("7-2. 세그먼트별 개인 당첨 분포", S_H2))
    story.append(make_table(
        ["세그먼트", "0회", "1회", "2회", "3회+", "평균"],
        [
            ["고래 (1%)", "0%", "0%", "0%", "100%", "11.89"],
            ["열성 (9%)", "0%", "0%", "0%", "100%", "8.93"],
            ["일반 (50%)", "7%", "20%", "27%", "46%", "2.46"],
            ["라이트 (30%)", "29%", "39%", "22%", "11%", "1.18"],
            ["신규 (10%)", "6%", "20%", "28%", "46%", "2.47"],
        ],
        col_widths=[28*mm, 18*mm, 18*mm, 18*mm, 18*mm, W - 100*mm]
    ))

    story.append(Paragraph("7-3. 대기열 재배정 (P3)", S_H2))
    story.append(Paragraph("  취소 1,785건 -> 재배정 1,785건 (100%). 모든 취소 티켓이 액면가로 재배정됨.", S_BODY))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 8. 코드 변경
    # ═══════════════════════════════════════════════
    story.append(Paragraph("8. 코드 변경 사항", S_H1))

    code_items = [
        ("8-1. SaleMode enum", "engine/talkfile_engine/sale_modes.py",
         "MEMBERSHIP_PRESALE, LOTTERY, QUEUE_SALE, FCFS_RESIDUAL\nLEGACY_ALIASES: fixed_fcfs -> FCFS_RESIDUAL, point_lottery -> LOTTERY, fanclub_presale -> MEMBERSHIP_PRESALE"),
        ("8-2. 프론트엔드 레이블", "packages/lib/src/constants.ts",
         "멤버십 선판매 (#4ECDC4), 공정 추첨 (#6c5ce7), 대기열 판매 (#0984e3), 잔여 선착순 (#00d2a0)"),
        ("8-3. 공정 추첨 함수", "engine/talkfile_engine/fair_lottery.py",
         "calc_lottery_weight(ap_invested, consecutive_losses, is_newbie, same_artist_30d, same_genre_30d, multi_win_60d)"),
        ("8-4. AP 수수료 할인", "packages/lib/src/ap-discount.ts",
         "BOOKING_FEE=2000, MAX_DISCOUNT_RATE=0.70, calcFeeDiscount(availableAP) -> {discount, finalFee, apUsed}"),
        ("8-5. DB 마이그레이션", "alembic migration",
         "sale_mode 값 변환 + ap_transactions.expires_at 컬럼 + platform_settings (booking_fee, max_discount_rate)"),
    ]
    for title, path, desc in code_items:
        story.append(Paragraph(title, S_H2))
        story.append(Paragraph(f"  파일: {path}", S_SMALL))
        story.append(Paragraph(f"  {desc}", S_BODY))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 9. 용어 통일
    # ═══════════════════════════════════════════════
    story.append(Paragraph("9. 용어 통일 (전사 강제)", S_H1))
    story.append(make_table_left_first(
        ["대상", "정식 명칭", "짧은 배지", "금지 표현"],
        [
            ["멤버십 선판매", "멤버십 선판매", "멤버십", "팬클럽 선예매, 커뮤니티 선판매"],
            ["공정 추첨", "공정 추첨", "추첨", "마일리지 경매, AP 공정배분, 포인트 추첨"],
            ["대기열 판매", "대기열 판매", "대기열", "웨이팅룸"],
            ["잔여 선착순", "잔여 선착순", "선착순", "정가 선착순"],
            ["액면가 대기", "액면가 대기", "대기자", "리세일, 재판매"],
            ["AP", "AP (Action Point)", "AP", "포인트, 코인, 마일리지"],
        ],
        col_widths=[28*mm, 30*mm, 22*mm, W - 80*mm]
    ))
    story.append(Paragraph('  "열정투자": 마케팅 슬로건으로만 사용. 시스템/문서에서는 "AP 투입".', S_SMALL))

    # ═══════════════════════════════════════════════
    # 10. 글로벌 정합성
    # ═══════════════════════════════════════════════
    story.append(Paragraph("10. 글로벌 정합성", S_H1))
    story.append(make_table_left_first(
        ["규제/모델", "Pickket 대응"],
        [
            ["한국 암표법 (2026 하반기)", "전 모드 1인2매 + 1계정1기기 + 봇탐지"],
            ["일본 3단계 모델", "MEMBERSHIP->LOTTERY->FCFS로 1:1 매핑"],
            ["일본 암표방지법", "Locked Ticket(P2) + WAITLIST(P3)"],
            ["UK CMA 가격 투명성", "P1 All-in pricing"],
            ["UK 재판매 금지법", "WAITLIST로 선제 대응"],
            ["DICE Waitlist 모델", "P3 액면가 대기 = DICE DNA"],
            ["Glastonbury 랜덤 큐", "QUEUE_SALE = 랜덤 큐"],
        ],
        col_widths=[45*mm, W - 45*mm]
    ))

    # ═══════════════════════════════════════════════
    # 11. 후속 작업
    # ═══════════════════════════════════════════════
    story.append(Paragraph("11. 후속 작업", S_H1))
    story.append(make_table_left_first(
        ["순서", "작업", "의존"],
        [
            ["1", "CEO 최종 승인 -> 확정 완료", "-"],
            ["2", "AP_POINT_POLICY.md 개정", "확정"],
            ["3", "sale_modes.py enum 변경", "확정"],
            ["4", "fair_lottery.py 신규", "확정"],
            ["5", "constants.ts 레이블 통일", "3"],
            ["6", "DB 마이그레이션", "3"],
            ["7", "ap-discount.ts 신규", "확정"],
            ["8", "QUEUE_SALE 구현 (Cloudflare)", "3"],
            ["9", "Consumer 페이지 용어 통일", "5"],
            ["10", "v1 정책서 -> archive 이동", "전체"],
        ],
        col_widths=[15*mm, 55*mm, W - 70*mm]
    ))

    story.append(Spacer(1, 8*mm))
    story.append(hr())

    # 변경 이력
    story.append(Paragraph("변경 이력", S_H2))
    story.append(make_table_left_first(
        ["버전", "날짜", "내용"],
        [
            ["v3.0", "2026-04-10", "CEO 확정. 수수료 2,000원 + AP 할인 70%캡. 추첨 AP 소비. 업계 벤치마크. 전체 시뮬 검증."],
            ["v2.1", "2026-04-10", "AP 이중 용도, 로그 스케일 공식, 사용자 편익 재구성"],
            ["v2.0", "2026-04-10", "4모드+1메커니즘 재편, AP 1년 절대소멸, 글로벌 분석"],
            ["v1.0", "2026-03-12", "최초 3모드 확정 (CEO 결정)"],
        ],
        col_widths=[15*mm, 25*mm, W - 40*mm]
    ))

    # ─── 빌드 ───
    doc.build(story, canvasmaker=FooterCanvas)
    print(f"PDF 생성 완료: {output_path}")
    return output_path


if __name__ == "__main__":
    build_pdf()
