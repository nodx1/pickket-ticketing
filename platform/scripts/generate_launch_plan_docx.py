"""Pickket 4월 1일 런칭 플랜 Word 문서 생성 스크립트 v1.2 — CEO(홍보)/CSO(세일즈) 역할 재분배"""

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
import os

doc = Document()

# ── 스타일 설정 ──
style = doc.styles["Normal"]
style.font.name = "맑은 고딕"
style.font.size = Pt(10)
style.paragraph_format.space_after = Pt(4)
style.paragraph_format.line_spacing = 1.15

for level in range(1, 4):
    h = doc.styles[f"Heading {level}"]
    h.font.name = "맑은 고딕"
    h.font.color.rgb = RGBColor(0x1E, 0x40, 0xAF)

# ── 페이지 설정 ──
section = doc.sections[0]
section.top_margin = Cm(2.5)
section.bottom_margin = Cm(2.5)
section.left_margin = Cm(2.5)
section.right_margin = Cm(2.5)


def add_table(headers, rows):
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = "Light Grid Accent 1"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, h in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = h
        for p in cell.paragraphs:
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for run in p.runs:
                run.bold = True
                run.font.size = Pt(9)
    for r_idx, row in enumerate(rows):
        for c_idx, val in enumerate(row):
            cell = table.rows[r_idx + 1].cells[c_idx]
            cell.text = str(val)
            for p in cell.paragraphs:
                for run in p.runs:
                    run.font.size = Pt(9)
    doc.add_paragraph()


# ═══════════════════════════════════════════
# 표지
# ═══════════════════════════════════════════
for _ in range(4):
    doc.add_paragraph()

title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = title.add_run("Pickket")
run.font.size = Pt(36)
run.font.color.rgb = RGBColor(0x63, 0x66, 0xF1)
run.bold = True

subtitle = doc.add_paragraph()
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = subtitle.add_run("4월 1일 정식 서비스 런칭 플랜")
run.font.size = Pt(20)
run.font.color.rgb = RGBColor(0x1E, 0x40, 0xAF)

doc.add_paragraph()

company = doc.add_paragraph()
company.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = company.add_run("node.x (노드엑스)")
run.font.size = Pt(14)
run.font.color.rgb = RGBColor(0x37, 0x41, 0x51)
run.bold = True

doc.add_paragraph()

meta = doc.add_paragraph()
meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = meta.add_run("작성일: 2026년 3월 8일  |  목표일: 2026년 4월 1일  |  v1.2")
run.font.size = Pt(11)
run.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)

doc.add_page_break()

# ═══════════════════════════════════════════
# 목차
# ═══════════════════════════════════════════
doc.add_heading("목차", level=1)
toc_items = [
    "0. 조직 및 업무 분장",
    "   0-1. 구성원 및 직책",
    "   0-2. 역할 정의 및 세부 업무",
    "   0-3. RACI 매트릭스",
    "   0-4. 커뮤니케이션 체계",
    "1. 현황 요약",
    "2. 4주 스프린트 계획",
    "   Week 1: 인프라 안정화 + 전체 서비스 배포",
    "   Week 2: 외부 서비스 연동 + 기능 완성",
    "   Week 3: QA 안정화 + 콘텐츠 준비",
    "   Week 4: 최종 점검 + 런칭",
    "3. 마케팅 전략",
    "4. 프로모션 계획",
    "5. Go/No-Go 체크리스트",
    "6. 크리티컬 패스 & 리스크",
    "7. 프로덕션 환경변수",
    "8. 런칭 후 로드맵",
]
for item in toc_items:
    p = doc.add_paragraph(item)
    p.paragraph_format.space_after = Pt(2)

doc.add_page_break()

# ═══════════════════════════════════════════
# 0. 조직 및 업무 분장
# ═══════════════════════════════════════════
doc.add_heading("0. 조직 및 업무 분장", level=1)

doc.add_heading("0-1. 회사 개요", level=2)
add_table(
    ["항목", "내용"],
    [
        ["회사명", "node.x (노드엑스)"],
        ["서비스명", "Pickket — VCG 공정배분 티켓팅 SaaS"],
        ["설립", "2026년"],
    ],
)

doc.add_heading("0-2. 구성원 및 직책", level=2)
add_table(
    ["이름", "직책", "담당 영역"],
    [
        ["곽민철", "대표이사 (CEO)", "경영 총괄, 홍보/PR/콘텐츠, 브랜드, 최종 의사결정"],
        ["최봉현", "이사, 사업·세일즈 총괄 (CSO)", "B2B 세일즈, 사업 개발, 파트너십, 운영 지원"],
        ["김혜진", "서비스 PM", "서비스 기획, UX/QA, 운영, CS"],
        ["곽민성", "개발 총괄 (CTO)", "기술 아키텍처, 개발, 인프라, 보안"],
    ],
)

doc.add_heading("0-3. 역할 정의 및 세부 업무", level=2)

# CEO
doc.add_heading("곽민철 대표이사 — CEO (홍보 전문)", level=3)
doc.add_paragraph(
    "핵심 역할: 경영 총괄 + 대외 홍보/PR 직접 리드\n"
    "스타트업 초기 단계에서 대표가 홍보 전문성을 살려 PR·콘텐츠·소셜미디어를 직접 운영하고, "
    "대외 활동(매체/지자체/파트너)의 첫 접점 역할을 수행한다."
)
add_table(
    ["분류", "세부 업무"],
    [
        ["경영 전략", "사업 방향 수립, OKR/KPI 설정, 분기 목표 관리"],
        ["재무", "예산 승인, 비용 집행 결재, 수익 모델 확정"],
        ["PR/언론", "보도자료 작성·배포, 매체 관계 구축, 기자 미팅, 인터뷰 대응"],
        ["콘텐츠", "블로그 포스트 기획·작성, 사례 연구, 뉴스레터 발행"],
        ["소셜 미디어", "X/LinkedIn/Instagram/네이버 블로그 계정 생성·운영, 콘텐츠 캘린더"],
        ["브랜드", "브랜드 메시지 수립, 비주얼 아이덴티티 관리, 톤앤매너 가이드"],
        ["런칭 이벤트", "런칭 이벤트 기획·연출, 라이브 진행, SNS 실시간 업데이트"],
        ["대외 관계", "투자자 IR, 지자체장·관광공사 첫 미팅 (영업은 CSO가 후속)"],
        ["법무/규제", "이용약관·개인정보처리방침 최종 승인, PG 계약 서명"],
        ["Go/No-Go", "런칭 최종 결정권"],
    ],
)
doc.add_paragraph("런칭 내 핵심 담당:")
for task in [
    "W1: PortOne PG 계약 서명, Railway Pro 결재, 소셜 미디어 4채널 개설",
    "W1-2: VCG 인사이트 소셜 포스트 발행 (주 2-3회)",
    "W2: SendGrid/NCP 계약, 런칭 카운트다운 SNS 시작",
    "W3: 블로그 3건 작성, 보도자료 작성 + 뉴스와이어 배포",
    "W4: Go/No-Go 결정, 런칭 당일 SNS 라이브 + 매체 인터뷰",
]:
    doc.add_paragraph(f"  - {task}")

# CSO
doc.add_heading("최봉현 이사 — 사업·세일즈 총괄 (CSO)", level=3)
doc.add_paragraph(
    "핵심 역할: B2B 세일즈 실행, 파트너십 체결, 사업 운영\n"
    "CEO가 홍보/PR을 리드하므로, CSO는 실제 매출을 만드는 세일즈·파트너십·사업개발에 "
    "집중하고 프로모션/커뮤니티 운영을 병행한다."
)
add_table(
    ["분류", "세부 업무"],
    [
        ["B2B 세일즈", "지자체 담당자 리스트업·컨택, PDF 제안서 작성, 이메일 세일즈, 데모 진행"],
        ["파트너십", "관광공사/축제 조직위/대학교 실무 접촉, MOU 협상·체결"],
        ["사업 개발", "수익 모델 분석, 경쟁사 벤치마킹, 시장 조사 리포트"],
        ["프로모션", "얼리어답터(Pioneer) 프로그램 운영, 프로모션 성과 추적"],
        ["커뮤니티", "카카오톡 오픈채팅/디스코드 개설·운영, 사용자 피드백 수집"],
        ["외부 계약", "SendGrid/NCP/Sentry 등 외부 서비스 계약 실무 (CEO 결재 전 준비)"],
        ["예산 관리", "마케팅·세일즈 예산 편성·집행 (광고비, 이벤트 경품)"],
        ["GTM 지원", "CEO의 PR 활동 후속 — 관심 리드 팔로업, 전환 관리"],
    ],
)
doc.add_paragraph("런칭 내 핵심 담당:")
for task in [
    "W1-2: 지자체 담당자 50곳 리스트업 + 컨택 시작",
    "W2: PDF 제안서 제작, 이메일 세일즈 발송, 커뮤니티 채널 개설",
    "W3: 관심 지자체 데모 미팅, 파트너십 제안서 발송, Pioneer 프로그램 세팅",
    "W4: 런칭 이벤트 운영 지원 (경품·물류), Pioneer 프로그램 개시",
]:
    doc.add_paragraph(f"  - {task}")

# PM
doc.add_heading("김혜진 — 서비스 PM", level=3)
doc.add_paragraph("핵심 역할: 서비스 품질 보증, 사용자 경험 설계, 운영 체계 구축")
add_table(
    ["분류", "세부 업무"],
    [
        ["서비스 기획", "기능 요구사항 정의, 화면 설계, 유저 스토리 작성"],
        ["UX/UI 관리", "디자인 리뷰, 사용성 테스트, UI 일관성 검수"],
        ["QA 총괄", "테스트 시나리오 작성, E2E 수동 테스트, 버그 리포트"],
        ["i18n 검수", "7개 언어 번역 품질 검토, 문맥 오류 확인"],
        ["운영 체계", "CS 프로세스 수립, FAQ 작성, 운영 매뉴얼"],
        ["데이터 분석", "GA4 이벤트 설계, 전환율 리포트"],
        ["콘텐츠 QA", "법적 페이지 검토, 용어 정확성"],
        ["데모 데이터", "시드 이벤트 기획 (이름/설명/이미지/가격)"],
        ["일정 관리", "스프린트 추적, 마일스톤 체크, 주간 리포트"],
        ["온보딩", "주최자 가이드 제작, 온보딩 플로우 설계"],
    ],
)
doc.add_paragraph("런칭 내 핵심 담당:")
for task in [
    "W1: OG 이미지 제작, 데모 이벤트 콘텐츠 기획",
    "W2: GA4 이벤트 설계서, 번역 품질 검수",
    "W3: E2E 수동 테스트, 모바일 QA, 운영 매뉴얼+FAQ",
    "W4: 스모크 테스트 참여, 런칭 당일 CS 대기",
]:
    doc.add_paragraph(f"  - {task}")

# CTO
doc.add_heading("곽민성 — 개발 총괄 (CTO)", level=3)
doc.add_paragraph("핵심 역할: 기술 의사결정, 시스템 안정성, 개발 실행")
add_table(
    ["분류", "세부 업무"],
    [
        ["아키텍처", "시스템 설계, 기술 스택 결정, 확장성 설계"],
        ["개발 관리", "Codex 프롬프트 작성·리뷰, 코드 리뷰, PR 머지"],
        ["인프라/DevOps", "Railway 배포, DNS 설정, CI/CD 파이프라인"],
        ["보안", "환경변수 설정, CORS/쿠키/CSP, 감사 점검"],
        ["DB 관리", "마이그레이션, 백업/복구 드릴, 인덱스 최적화"],
        ["외부 연동", "PortOne/SendGrid/NCP/Sentry 기술 연동"],
        ["테스트", "자동화 테스트 유지, 부하 테스트"],
        ["모니터링", "Sentry 설정, Railway 메트릭, 장애 대응"],
        ["문서화", "API 문서, 배포 가이드, 런북"],
        ["온콜", "런칭 당일 + 1주차 온콜, 장애 즉시 대응"],
    ],
)
doc.add_paragraph("런칭 내 핵심 담당:")
for task in [
    "W1: Go (주최자)/Admin/Celery 배포, DNS CNAME, 마이그레이션 수정",
    "W2: PortOne/SendGrid/Sentry/GA4 기술 연동, Codex V5",
    "W3: 부하 테스트, 보안 점검, 백업/복구 드릴",
    "W4: 환경변수 최종 설정, 코드 프리즈, 런칭 모니터링",
]:
    doc.add_paragraph(f"  - {task}")

doc.add_page_break()

doc.add_heading("0-4. RACI 매트릭스", level=2)
doc.add_paragraph("R=Responsible(실행), A=Accountable(책임), C=Consulted(협의), I=Informed(공유)")
add_table(
    ["업무", "곽민철 CEO", "최봉현 CSO", "김혜진 PM", "곽민성 CTO"],
    [
        ["Railway 배포 + DNS", "I", "I", "I", "R/A"],
        ["외부 서비스 계약", "A", "R", "I", "C"],
        ["프로덕션 환경변수", "I", "I", "I", "R/A"],
        ["Codex V5 기능 개발", "I", "I", "C", "R/A"],
        ["E2E QA 테스트", "I", "I", "R/A", "C"],
        ["모바일/i18n 검수", "I", "I", "R/A", "C"],
        ["부하 테스트 + 보안", "I", "I", "C", "R/A"],
        ["블로그/콘텐츠 작성", "R/A", "C", "C", "C"],
        ["보도자료 + PR", "R/A", "I", "C", "I"],
        ["소셜 미디어 운영", "R/A", "C", "I", "I"],
        ["지자체 세일즈", "C", "R/A", "C", "I"],
        ["파트너십 MOU", "R (첫 미팅)", "R/A (실무)", "I", "I"],
        ["런칭 이벤트 기획·연출", "R/A", "R (운영)", "C", "C"],
        ["데모 이벤트 콘텐츠", "C", "C", "R/A", "C"],
        ["프로모션/Pioneer", "C", "R/A", "C", "I"],
        ["커뮤니티 운영", "C", "R/A", "C", "I"],
        ["운영 매뉴얼/FAQ", "I", "C", "R/A", "C"],
        ["법적 문서 검토", "R/A", "C", "R", "I"],
        ["예산 승인", "R/A", "R", "I", "I"],
        ["Go/No-Go 결정", "R/A", "C", "C", "C"],
        ["런칭 당일 모니터링", "I", "I", "R", "R/A"],
        ["장애 대응/온콜", "I", "I", "I", "R/A"],
    ],
)

doc.add_heading("0-5. 커뮤니케이션 체계", level=2)
add_table(
    ["채널", "용도", "주기"],
    [
        ["매일 스탠드업 (15분)", "전일 완료/금일 계획/블로커", "매일 오전 10시"],
        ["주간 리뷰 (1시간)", "마일스톤 점검, 리스크 논의", "매주 금요일 오후 3시"],
        ["Slack/카카오톡", "긴급 이슈, 실시간 소통", "상시"],
        ["Notion/GitHub Issues", "태스크 관리, 버그 트래킹", "상시"],
        ["Go/No-Go 미팅 (전원)", "런칭 최종 결정", "3/29 (D-3)"],
    ],
)

doc.add_page_break()

# ═══════════════════════════════════════════
# 1. 현황 요약
# ═══════════════════════════════════════════
doc.add_heading("1. 현황 요약", level=1)

doc.add_heading("1-1. 프로젝트 개요", level=2)
doc.add_paragraph(
    "Pickket은 node.x(노드엑스)가 운영하는 VCG 공정배분 엔진 기반의 티켓팅 SaaS 플랫폼이다. "
    "선착순이 아닌 공정 배분 메커니즘으로, 매크로/봇 부정예약을 원천 차단하고 "
    "모든 사용자에게 동등한 기회를 보장한다."
)
doc.add_paragraph(
    "기술 스택: Next.js 16 (App Router) + FastAPI + SQLAlchemy + PostgreSQL + Redis + Celery\n"
    "모노레포 구조: Consumer / Go (주최자) / Admin / Backend / Engine\n"
    "지원 언어: 한국어, 영어, 일본어, 중국어, 프랑스어, 러시아어, 베트남어 (7개)\n"
    "결제: PortOne V2 (카드, 카카오페이, 네이버페이, 토스페이, 계좌이체)"
)

doc.add_heading("1-2. 개발 완성도", level=2)
add_table(
    ["영역", "상태", "수치"],
    [
        ["Backend API", "완료", "314 엔드포인트, 60 모델, 61 서비스"],
        ["Backend 테스트", "통과", "604 passed, 58 skipped"],
        ["공정배분 엔진", "완료", "536 tests passed (VCG/Dutch/Lottery)"],
        ["Consumer", "완료", "40 라우트, 96 컴포넌트, 빌드 성공"],
        ["Go (주최자)", "완료", "23 라우트, 빌드 성공"],
        ["Admin", "완료", "16 라우트, 빌드 성공"],
        ["보안 감사", "통과", "100/100 (55개 검증 항목)"],
        ["CI/CD", "구축", "GitHub Actions 19/19 jobs green"],
    ],
)

doc.add_heading("1-3. 배포 현황", level=2)
add_table(
    ["서비스", "도메인", "상태"],
    [
        ["Backend API", "api.pickket.kr", "배포 완료"],
        ["Consumer", "www.pickket.kr", "배포 완료"],
        ["PostgreSQL", "Railway 내부", "배포 완료"],
        ["Redis", "Railway 내부", "배포 완료"],
        ["Go (주최자)", "go.pickket.kr", "배포완료"],
        ["Admin", "admin.pickket.kr", "미배포"],
        ["Celery Worker", "-", "미배포"],
        ["Celery Beat", "-", "미배포"],
    ],
)

doc.add_page_break()

# ═══════════════════════════════════════════
# 2. 4주 스프린트
# ═══════════════════════════════════════════
doc.add_heading("2. 4주 스프린트 계획", level=1)

# Week 1
doc.add_heading("Week 1 (3/8~14): 인프라 안정화 + 전체 서비스 배포", level=2)
doc.add_paragraph("목표: 4개 서비스 Railway 배포 + DNS 정상화")

doc.add_heading("개발 작업", level=3)
add_table(
    ["#", "작업", "담당"],
    [
        ["1", "Go (주최자)/Admin output: standalone 추가", "곽민성 (Codex)"],
        ["2", "Go (주최자)/Admin Dockerfile 생성", "곽민성 (Codex)"],
        ["3", "Celery Beat 스케줄 영속화", "곽민성 (Codex)"],
        ["4", "마이그레이션 레이스 컨디션 수정", "곽민성 (Codex)"],
        ["5", "OG 이미지 생성 (1200x630px)", "김혜진"],
    ],
)

doc.add_heading("인프라 작업", level=3)
add_table(
    ["#", "작업", "담당"],
    [
        ["1", "Railway Go (주최자)/Admin 배포", "곽민성"],
        ["2", "Railway Celery Worker/Beat 배포", "곽민성"],
        ["3", "Gabia DNS CNAME 수정", "곽민성"],
        ["4", "PortOne PG 심사 신청 (즉시)", "곽민철 + 곽민성"],
        ["5", "Railway Pro 플랜 결재", "곽민철"],
    ],
)

doc.add_heading("비개발 작업", level=3)
add_table(
    ["#", "작업", "담당"],
    [
        ["1", "소셜 미디어 계정 생성 (X/LinkedIn/Instagram/네이버)", "곽민철"],
        ["2", "지자체 담당자 리스트업 (50곳)", "최봉현"],
        ["3", "데모 이벤트 콘텐츠 기획", "김혜진"],
        ["4", "E2E 테스트 시나리오 작성", "김혜진"],
    ],
)

doc.add_heading("Week 1 마일스톤", level=3)
for item in [
    "go/admin.pickket.kr HTTPS 접속 — 곽민성",
    "Celery Worker/Beat 정상 동작 — 곽민성",
    "소셜 미디어 4개 채널 개설 — 곽민철",
]:
    doc.add_paragraph(f"☐ {item}")

doc.add_page_break()

# Week 2
doc.add_heading("Week 2 (3/15~21): 외부 서비스 연동 + 기능 완성", level=2)
doc.add_paragraph("목표: 프로덕션 외부 연동 완료, 잔여 기능 구현")

doc.add_heading("외부 서비스 연동", level=3)
add_table(
    ["#", "서비스", "담당", "비고"],
    [
        ["1", "SendGrid 이메일", "최봉현(계약) + 곽민성(기술)", "SPF/DKIM"],
        ["2", "NCP SMS", "최봉현(계약) + 곽민성(기술)", "발신번호 등록"],
        ["3", "PortOne 프로덕션", "곽민성", "웹훅 URL 등록"],
        ["4", "Sentry", "곽민성", "에러 추적"],
        ["5", "GA4", "곽민성 + 김혜진(이벤트)", "전환 추적"],
        ["6", "본인인증", "곽민철(결정) + 곽민성(기술)", "방향 결정"],
    ],
)

doc.add_heading("기능 개발 (Codex V5) — 곽민성", level=3)
add_table(
    ["Prompt", "핵심 내용"],
    [
        ["A: TimeSlot → Order", "time_slot 필드 추가, 잔여석 계산"],
        ["B: 검색바 + Skeleton", "Consumer 헤더 검색, 로딩 UI"],
        ["C: 지자체 랜딩 + 시드", "/government 페이지, 데모 6건"],
    ],
)

doc.add_heading("세일즈 작업 — 최봉현", level=3)
add_table(
    ["#", "작업"],
    [
        ["1", "PDF 제안서 제작 (지자체용)"],
        ["2", "이메일 세일즈 발송 (50곳)"],
        ["3", "커뮤니티 채널 개설 (카카오톡/디스코드)"],
    ],
)

doc.add_heading("홍보 작업 — 곽민철", level=3)
add_table(
    ["#", "작업"],
    [
        ["1", "VCG 인사이트 소셜 포스트 (주 2-3회)"],
        ["2", "런칭 카운트다운 SNS 콘텐츠 시작"],
    ],
)

doc.add_heading("PM 작업 — 김혜진", level=3)
add_table(
    ["#", "작업"],
    [
        ["1", "GA4 이벤트 트래킹 설계서"],
        ["2", "번역 품질 검수 (주요 화면)"],
        ["3", "데모 이벤트 시드 데이터 기획"],
    ],
)

doc.add_heading("Week 2 마일스톤", level=3)
for item in [
    "이메일 발송 테스트 성공 — 곽민성",
    "PortOne 결제 플로우 성공 — 곽민성",
    "지자체 50곳 이메일 발송 — 최봉현",
]:
    doc.add_paragraph(f"☐ {item}")

doc.add_page_break()

# Week 3
doc.add_heading("Week 3 (3/22~28): QA 안정화 + 콘텐츠 준비", level=2)
doc.add_paragraph("목표: 버그 0건, 성능 검증, 마케팅 콘텐츠 준비")

doc.add_heading("QA & 테스트", level=3)
add_table(
    ["#", "작업", "담당"],
    [
        ["1", "Consumer E2E (가입→결제→체크인)", "김혜진"],
        ["2", "Go (주최자) E2E (이벤트→배분→정산)", "김혜진"],
        ["3", "Admin E2E (RBAC, 감사 로그)", "김혜진"],
        ["4", "모바일 반응형 QA", "김혜진"],
        ["5", "부하 테스트 (p95 < 500ms)", "곽민성"],
        ["6", "보안 최종 점검", "곽민성"],
        ["7", "백업/복구 드릴", "곽민성"],
        ["8", "법적 문서 검토", "김혜진 + 곽민철(승인)"],
    ],
)

doc.add_heading("콘텐츠 + PR — 곽민철 리드", level=3)
add_table(
    ["#", "콘텐츠", "작성", "검수"],
    [
        ["1", "블로그: VCG 메커니즘", "곽민철", "곽민성 (기술)"],
        ["2", "블로그: 지자체 도입", "곽민철", "김혜진 (서비스)"],
        ["3", "블로그: 런칭 발표", "곽민철", "전원"],
        ["4", "보도자료 + 뉴스와이어 배포", "곽민철", "-"],
    ],
)

doc.add_heading("운영 체계 구축 — 김혜진", level=3)
for item in [
    "운영 매뉴얼 (장애 대응, 에스컬레이션)",
    "FAQ (사용자 20문항, 주최자 15문항)",
    "주최자 온보딩 가이드",
    "CS 프로세스 (support@pickket.kr)",
]:
    doc.add_paragraph(f"  - {item}")

doc.add_heading("Week 3 마일스톤", level=3)
for item in [
    "0 크리티컬 버그 — 김혜진",
    "p95 < 500ms — 곽민성",
    "블로그 3건 + 보도자료 — 곽민철",
    "운영 매뉴얼 + FAQ — 김혜진",
]:
    doc.add_paragraph(f"☐ {item}")

# Week 4
doc.add_heading("Week 4 (3/29~4/1): 최종 점검 + 런칭", level=2)
add_table(
    ["일자", "작업", "담당"],
    [
        ["3/29", "Go/No-Go 체크리스트 점검", "전원"],
        ["3/29", "Go/No-Go 최종 결정", "곽민철"],
        ["3/30", "환경변수 최종 검증", "곽민성"],
        ["3/30", "스모크 테스트 (실결제)", "김혜진 + 곽민성"],
        ["3/31 18:00", "코드 프리즈", "곽민성"],
        ["3/31", "런칭 이벤트 세팅 (경품, 물류)", "최봉현"],
        ["4/1 00:00", "정식 서비스 오픈", "곽민철 공식 발표"],
        ["4/1 오전", "런칭 모니터링", "곽민성 + 김혜진"],
        ["4/1 오후", "런칭 이벤트 운영", "최봉현 (현장) + 곽민철 (SNS 라이브)"],
        ["4/1", "매체 인터뷰", "곽민철 (리드) + 최봉현"],
    ],
)

doc.add_page_break()

# ═══════════════════════════════════════════
# 3. 마케팅
# ═══════════════════════════════════════════
doc.add_heading("3. 마케팅 전략", level=1)

doc.add_heading("3-1. 타겟 오디언스", level=2)
add_table(
    ["구분", "대상", "접근 방법", "담당"],
    [
        ["1차", "전국 지자체", "PDF 제안서 + 이메일 + 데모", "최봉현 (세일즈) + 곽민철 (대표 미팅)"],
        ["2차", "민간 주최자", "커뮤니티 + 인플루언서", "최봉현"],
        ["3차", "대학교 축제위", "무료 파일럿", "최봉현"],
    ],
)

doc.add_heading("3-2. USP (핵심 차별점)", level=2)
for i, usp in enumerate([
    "VCG 공정배분 엔진 — 수학적 공정 배분 (세계 최초)",
    "내장형 봇 방지 — 별도 솔루션 불필요",
    "7개 언어 지원 — 외국인 관광객 대응",
    "투명성 리포트 — 배분 과정 공개 API",
    "SaaS 즉시 배포 — 구축비 없이 즉시 사용",
], 1):
    doc.add_paragraph(f"{i}. {usp}")

doc.add_heading("3-3. 소셜 미디어 — 곽민철 운영", level=2)
add_table(
    ["채널", "W1-2 (준비기)", "W3-4 (런칭기)"],
    [
        ["X (Twitter)", "계정 생성, VCG 인사이트", "카운트다운, 데모 영상"],
        ["LinkedIn", "회사 페이지, B2B 콘텐츠", "지자체 타겟 PR"],
        ["Instagram", "UI 스크린샷", "런칭 이벤트 스토리"],
        ["네이버 블로그", "핵심 포스트 포팅", "사용법 가이드"],
    ],
)

doc.add_heading("3-4. PR/언론 — 곽민철 리드", level=2)
add_table(
    ["시점", "활동", "대상 매체"],
    [
        ["W3", "보도자료 작성 + 배포", "IT조선, 지디넷, 블로터, 벤처스퀘어"],
        ["W4", "런칭 당일 인터뷰", "관심 매체"],
        ["W4+", "지자체 전문 매체", "지방행정 관련 매체"],
    ],
)

doc.add_page_break()

# ═══════════════════════════════════════════
# 4. 프로모션
# ═══════════════════════════════════════════
doc.add_heading("4. 프로모션 계획", level=1)

doc.add_heading("4-1. 런칭 이벤트 — 곽민철 기획·연출, 최봉현 운영 지원", level=2)
add_table(
    ["이벤트", "일정", "내용"],
    [
        ["공정 배분 체험", "4/1 오후 2시", "VCG 라이브 배분, 100명 기프티콘"],
        ["얼리버드 주최자", "4/1~4/30", "수수료 0% + 프리미엄 무료"],
        ["개발자 밋업", "4월 중순", "VCG 알고리즘 기술 세미나"],
    ],
)

doc.add_heading("4-2. 얼리어답터 (Pickket Pioneer) — 최봉현 운영", level=2)
doc.add_paragraph("대상: 첫 1,000명 | 혜택: 배지, 포인트 2배, 우선 접근 | 기간: 4/1~5/31")

doc.add_heading("4-3. 파트너십 — 곽민철(첫 미팅) + 최봉현(실무)", level=2)
add_table(
    ["대상", "제안", "기대 효과"],
    [
        ["한국관광공사", "외국인 축제 티켓팅", "7개 언어, 정부 신뢰도"],
        ["지역 축제 조직위", "여름 축제 파트너", "실사용 사례"],
        ["대학교 축제위", "무료 파일럿", "MZ세대 + 입소문"],
    ],
)

doc.add_heading("4-4. 커뮤니티 — 최봉현 개설, 김혜진 운영", level=2)
for item in [
    "카카오톡 오픈채팅방: \"Pickket 공식 커뮤니티\"",
    "디스코드 서버: 개발자/주최자/사용자 채널 분리",
    "월간 뉴스레터: 배분 통계, 공정성 리포트, 신기능 안내",
]:
    doc.add_paragraph(f"  - {item}")

doc.add_page_break()

# ═══════════════════════════════════════════
# 5. Go/No-Go
# ═══════════════════════════════════════════
doc.add_heading("5. Go/No-Go 체크리스트", level=1)

doc.add_heading("5-1. MUST (미완 시 런칭 연기)", level=2)
add_table(
    ["#", "항목", "담당", "현재"],
    [
        ["1", "Go (주최자)/Admin HTTPS 접속", "곽민성", "미완"],
        ["2", "DNS CNAME 정상 전파", "곽민성", "미완"],
        ["3", "Celery Worker/Beat 동작", "곽민성", "미완"],
        ["4", "이메일 실제 발송", "곽민성", "미완"],
        ["5", "실결제 성공 (1,000원)", "곽민성+김혜진", "미완"],
        ["6", "전체 테스트 통과", "곽민성", "완료"],
        ["7", "Health check 정상", "곽민성", "확인 필요"],
        ["8", "CORS/쿠키 보안", "곽민성", "확인 필요"],
        ["9", "회원가입→주문 E2E", "김혜진", "미완"],
        ["10", "DB 백업 1회 완료", "곽민성", "미완"],
        ["11", "OG 이미지 존재", "김혜진", "미완"],
        ["12", "Go/No-Go 최종 승인", "곽민철", "미완"],
    ],
)

doc.add_heading("5-2. SHOULD (권장)", level=2)
add_table(
    ["#", "항목", "담당", "비고"],
    [
        ["1", "Sentry DSN", "곽민성", "에러 추적"],
        ["2", "GA4", "곽민성+김혜진", "사용자 분석"],
        ["3", "SMS 프로바이더", "곽민성", "이메일 대체 가능"],
        ["4", "본인인증", "곽민성", "임시 완화 가능"],
        ["5", "Codex V5 기능", "곽민성", "런칭 후 가능"],
        ["6", "부하 테스트", "곽민성", "초기 트래픽 적음"],
    ],
)

doc.add_page_break()

# ═══════════════════════════════════════════
# 6. 크리티컬 패스
# ═══════════════════════════════════════════
doc.add_heading("6. 크리티컬 패스 & 리스크", level=1)

doc.add_heading("6-1. 크리티컬 패스", level=2)
add_table(
    ["#", "항목", "기간", "담당", "조치"],
    [
        ["1", "PortOne PG 심사", "5-10일", "곽민철+곽민성", "즉시 신청"],
        ["2", "DNS CNAME 전파", "최대 48h", "곽민성", "TTL 300s"],
        ["3", "이메일 도메인 인증", "24시간", "곽민성", "SPF/DKIM"],
        ["4", "본인인증", "2-4주", "곽민철", "KYC 또는 비활성화"],
    ],
)

doc.add_heading("6-2. 리스크 완화", level=2)
add_table(
    ["리스크", "확률", "영향", "완화", "담당"],
    [
        ["PG 심사 지연", "중", "높음", "즉시 신청 + 대안 PG", "곽민철"],
        ["본인인증 불가", "높", "높음", "비필수화 후 추후 연동", "곽민철"],
        ["Railway 한계", "중", "중간", "Pro 플랜 ($30/월)", "곽민철"],
        ["트래픽 부족", "높", "높음", "데모+파일럿 확보", "최봉현"],
        ["DNS 지연", "낮", "중간", "TTL 사전 단축", "곽민성"],
    ],
)

# ═══════════════════════════════════════════
# 7. 환경변수
# ═══════════════════════════════════════════
doc.add_heading("7. 프로덕션 환경변수 — 곽민성 설정, 곽민철 승인", level=1)
add_table(
    ["변수", "현재", "목표"],
    [
        ["ENVIRONMENT", "development", "production"],
        ["SECRET_KEY", "개발용", "32자+ 랜덤"],
        ["PORTONE_MOCK_MODE", "true", "false"],
        ["PORTONE_WEBHOOK_REQUIRE_TIMESTAMP", "false", "true"],
        ["PAYMENT_MANUAL_API_ENABLED", "true", "false"],
        ["REFRESH_COOKIE_SECURE", "false", "true"],
        ["EMAIL_PROVIDER", "stub", "sendgrid / ses"],
        ["SMS_PROVIDER", "stub", "ncp / twilio"],
        ["IDENTITY_PROVIDER", "stub", "portone / 비활성화"],
        ["CORS_ORIGINS", "*", "명시적 도메인"],
    ],
)

# ═══════════════════════════════════════════
# 8. 런칭 후 로드맵
# ═══════════════════════════════════════════
doc.add_heading("8. 런칭 후 로드맵", level=1)
add_table(
    ["시점", "작업", "담당"],
    [
        ["4월 1주", "모니터링, 핫픽스, 피드백 수집", "곽민성 + 김혜진"],
        ["4월 2-3주", "Codex V5 잔여 기능", "곽민성"],
        ["4월", "지자체 데모 미팅", "최봉현 + 곽민철"],
        ["5월", "파일럿 분석, 사례 연구", "최봉현 + 김혜진"],
        ["6월", "CDN, E2E 자동화, 고도화", "곽민성 + 김혜진"],
        ["Q3", "모바일 앱, 엔진 오픈소스", "곽민성"],
    ],
)

# ── 푸터 ──
doc.add_paragraph()
footer = doc.add_paragraph()
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = footer.add_run("node.x (노드엑스) — 2026년 3월 8일 작성")
run.font.size = Pt(9)
run.font.color.rgb = RGBColor(0x9C, 0xA3, 0xAF)

# ── 저장 ──
output_path = os.path.join(os.path.dirname(__file__), "LAUNCH_PLAN_2026-04-01.docx")
doc.save(output_path)
print(f"Word 문서 생성 완료: {output_path}")
