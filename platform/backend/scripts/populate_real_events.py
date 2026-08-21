"""Populate KBO All-Star & IU HEREH events with complete, realistic data."""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv()

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

DATABASE_URL = os.getenv("DATABASE_URL", "").replace(
    "postgresql://", "postgresql+asyncpg://"
)
engine = create_async_engine(DATABASE_URL)

KBO_ID = "b6503729-ecd7-4d02-9446-19493bd28854"
IU_ID = "d4f7a893-5a54-424e-9bef-d30cf73456fe"
ITZY_ID = "df97017b-dedf-49a5-b5e9-27630ea0391d"
MIDZY_FANCLUB_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
ORGANIZER_ID = "8994b42c-3771-40b3-836a-26bb139a8ace"


async def populate():
    async with engine.begin() as conn:
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # 1. KBO 올스타전
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        kbo_description = (
            "2026 KBO 올스타전이 부산 사직구장에서 개최됩니다!\n\n"
            "⚾ 대회 소개\n"
            "KBO리그 전반기 최고의 선수들이 한자리에 모이는 꿈의 무대.\n"
            "팬 투표로 선발된 나눔리그 vs 드림리그의 드림매치와 함께\n"
            "홈런더비, 올스타 퓨처스게임 등 풍성한 이벤트가 펼쳐집니다.\n\n"
            "🏟️ 경기 정보\n"
            "• 일시: 2026년 7월 12일 (일) 17:00\n"
            "• 장소: 부산 사직야구장 (25,000석)\n"
            "• 주최: KBO한국야구위원회\n"
            "• 후원: 신한은행, SOL뱅크\n\n"
            "🎉 부대행사\n"
            "• 12:00 — 팬 체험존 오픈 (사인회, 포토존, 스피드건 챌린지)\n"
            "• 14:00 — 퓨처스 올스타전 (유망주 경기)\n"
            "• 15:30 — 홈런더비 (출전 선수 4명 vs 4명)\n"
            "• 16:30 — 시구 및 축하 공연\n"
            "• 17:00 — 올스타전 본경기 (7이닝)\n"
            "• 경기 종료 후 — 불꽃놀이 + MVP 시상식\n\n"
            "⭐ 출전 예정 선수 (팬 투표 상위)\n"
            "• 나눔리그: 김도영(삼성), 이정후(키움), 양현종(KIA), 원태인(삼성)\n"
            "• 드림리그: 구자욱(삼성), 박건우(두산), 고우석(LG), 류현진(한화)\n"
            "※ 최종 로스터는 6월 말 확정\n\n"
            "🎁 관람 특전\n"
            "• 전 관중 올스타전 기념 유니폼 증정\n"
            "• 프리미엄석: 한정판 사인볼 추첨 + 선수 하이터치 이벤트\n"
            "• 경기 후 그라운드 개방 (포토타임)"
        )

        kbo_notice = (
            "📢 관람 안내사항\n\n"
            "• 입장 시 모바일 티켓 QR 스캔 (신분증 지참 권장)\n"
            "• 프리미엄석은 지정좌석, 일반석은 지정좌석\n"
            "• 외부 음식물 반입 가능 (캔/병 음료 제외, 컵에 옮겨 반입)\n"
            "• 전문 촬영 장비 반입 불가 (스마트폰 촬영 자유)\n"
            "• 응원도구: 막대풍선 현장 배포 (팬 체험존에서 수령)\n"
            "• 우천 시 1시간 딜레이 후 진행 여부 결정\n"
            "• 좌석 이동 금지 — 지정 구역 관람\n"
            "• 경기 후 불꽃놀이 시 이동 자제 요청\n"
            "• 반려동물 동반 불가\n"
            "• 분실물 센터: 1루 측 안내데스크"
        )

        kbo_parking = (
            "🚗 주차 안내\n\n"
            "• 사직구장 주차장: 약 800대 (선착순, 만차 예상)\n"
            "• 올스타전 당일 주차 요금: 1대 10,000원\n"
            "• 대중교통 이용 강력 권장\n\n"
            "🚇 대중교통\n"
            "• 부산 지하철 3호선 사직역 1번 출구 → 도보 10분\n"
            "• 부산 지하철 3호선 종합운동장역 3번 출구 → 도보 8분\n"
            "• 시내버스: 50, 51, 80, 83-1, 111, 131 → 사직구장 하차\n\n"
            "🚌 셔틀버스\n"
            "• 부산역 / 해운대역에서 올스타전 셔틀 운행\n"
            "• 12:00~16:30 수시 운행 (무료)\n"
            "• 경기 종료 후 30분간 복귀 셔틀 운행\n\n"
            "🚖 택시\n"
            "• '사직야구장 정문' 하차\n"
            "• 경기 후 택시 승차 대기 구역: 3루 측 후문"
        )

        kbo_program_notes = (
            "⚾ 올스타전 프로그램 상세\n\n"
            "━━━ 팬 체험존 (12:00~16:30) ━━━\n"
            "• 사인회: 올스타 선수 4명 참여 (30분 교대)\n"
            "• 포토존: 올스타 유니폼 착용 촬영\n"
            "• 스피드건 챌린지: 최고 구속 기록 시 상품 증정\n"
            "• VR 타석 체험: 150km/h 투구 가상 타격\n"
            "• 굿즈 부스: 올스타전 한정판 MD 판매\n"
            "• 키즈존: 어린이 야구 교실 (14:00~15:00)\n\n"
            "━━━ 퓨처스 올스타전 (14:00~15:30) ━━━\n"
            "• 2군 유망주 대결 (5이닝)\n"
            "• 미래의 스타를 미리 만나보세요\n\n"
            "━━━ 홈런더비 (15:30~16:30) ━━━\n"
            "• 1라운드: 각 리그 4명, 10구 제한\n"
            "• 결승: 1라운드 상위 1명씩 대결\n"
            "• 관중석 홈런볼 캐치 이벤트 (경품 추첨)\n\n"
            "━━━ 시구 & 축하 공연 (16:30~17:00) ━━━\n"
            "• 셀럽 시구 (추후 공개)\n"
            "• 미니 축하 공연\n\n"
            "━━━ 본경기 (17:00~) ━━━\n"
            "• 나눔리그 vs 드림리그 (7이닝)\n"
            "• 경기 중 관중 이벤트 (치어리더 퍼포먼스, 럭키석 추첨)\n"
            "• MVP 선정 후 시상식\n\n"
            "━━━ 불꽃놀이 (경기 종료 후) ━━━\n"
            "• 약 15분간 사직구장 상공 불꽃놀이\n"
            "• 그라운드 개방 포토타임"
        )

        kbo_stage_info = (
            "🏟️ 좌석 안내 — 사직야구장\n\n"
            "[프리미엄석]\n"
            "— 1루/3루 내야 지정석 최전방\n"
            "— 선수 덕아웃 근접 구역\n"
            "— 한정판 사인볼 추첨 참여\n"
            "— 선수 하이터치 이벤트 (경기 전)\n"
            "— 전용 입장 라인\n\n"
            "[일반석]\n"
            "— 내야/외야 지정좌석\n"
            "— 응원 막대풍선 배포\n"
            "— 전 관중 기념 유니폼 증정\n\n"
            "[시설 안내]\n"
            "— 매점: 각 층 4곳 (치킨, 피자, 핫도그, 음료)\n"
            "— 화장실: 각 층 4곳\n"
            "— 의무실: 1루 측 1층\n"
            "— 수유실: 3루 측 1층 안내데스크 옆\n"
            "— 장애인석: 1루/3루 측 지정 구역"
        )

        kbo_program_data = json.dumps({
            "fan_zone_open": "12:00",
            "futures_game": "14:00",
            "homerun_derby": "15:30",
            "ceremony": "16:30",
            "game_start": "17:00",
            "innings": 7,
            "fireworks": "경기 종료 후",
            "home_league": "나눔리그",
            "away_league": "드림리그",
        })

        kbo_tags = json.dumps(["KBO", "올스타전", "야구", "부산", "사직구장", "홈런더비", "스포츠"])

        kbo_desc_images = json.dumps([
            "https://picsum.photos/seed/kbo-allstar-field/1200/800",
            "https://picsum.photos/seed/kbo-homerun-derby/1200/800",
            "https://picsum.photos/seed/kbo-fan-zone/1200/800",
            "https://picsum.photos/seed/sajik-stadium/1200/800",
            "https://picsum.photos/seed/kbo-fireworks/1200/800",
        ])

        kbo_ticket_display = json.dumps({
            "includes": [
                "경기 관람 (올스타전 본경기 + 홈런더비 + 퓨처스전)",
                "기념 유니폼 1벌 (전 관중)",
                "팬 체험존 입장",
                "프리미엄석: 사인볼 추첨 + 선수 하이터치",
            ],
            "not_includes": ["주차비 (10,000원)", "매점 식음료", "굿즈 별도 구매"],
            "exchange_info": "모바일 QR 티켓으로 직접 입장 (별도 교환 불필요)",
            "entry_info": "팬 체험존 12:00 / 좌석 입장 13:00 / 경기 시작 17:00",
        })

        kbo_cancel_tiers = json.dumps([
            {"days_before": 7, "fee_pct": 0},
            {"days_before": 3, "fee_pct": 10},
            {"days_before": 1, "fee_pct": 30},
            {"days_before": 0, "fee_pct": 100},
        ])

        kbo_discount = json.dumps([
            {
                "type": "group",
                "name": "그룹 할인",
                "discount_pct": 10,
                "description": "4인 이상 동시 구매 시",
            },
            {
                "type": "youth",
                "name": "청소년 할인",
                "discount_pct": 30,
                "description": "만 18세 이하 (신분증 확인)",
            },
        ])

        await conn.execute(
            text("""
                UPDATE events SET
                    description = :description,
                    sub_category = 'KBO',
                    notice = :notice,
                    parking_info = :parking,
                    program_notes = :prog_notes,
                    stage_info = :stage,
                    program_data = :prog_data,
                    tags = :tags,
                    description_images = :desc_images,
                    ticket_display_info = :ticket_info,
                    cancellation_fee_tiers = :cancel_tiers,
                    discount_policies = :discount,
                    board_types = :board_types,
                    duration_minutes = 300,
                    age_restriction = '전체 관람가',
                    age_rating = '전체 관람가',
                    event_date_end = event_date + interval '5 hours',
                    broadcast_url = 'https://sports.naver.com',
                    broadcast_platform = 'SPOTV, KBS',
                    total_seats = 800,
                    participant_enabled = true
                WHERE id = :id
            """),
            {
                "id": KBO_ID,
                "description": kbo_description,
                "notice": kbo_notice,
                "parking": kbo_parking,
                "prog_notes": kbo_program_notes,
                "stage": kbo_stage_info,
                "prog_data": kbo_program_data,
                "tags": kbo_tags,
                "desc_images": kbo_desc_images,
                "ticket_info": kbo_ticket_display,
                "cancel_tiers": kbo_cancel_tiers,
                "discount": kbo_discount,
                "board_types": json.dumps(["free", "review", "photo"]),
            },
        )
        print("✅ KBO 올스타전 상세정보 업데이트 완료")

        # KBO tier updates
        await conn.execute(
            text("""
                UPDATE seat_tiers SET
                    view_description = '1루/3루 내야 최전방 지정석. 덕아웃 근접 구역. 선수 하이터치 이벤트 참여 가능.',
                    distance_from_stage = 5,
                    position_label = '내야 1-3열 (프리미엄)',
                    view_image_url = 'https://picsum.photos/seed/sajik-premium/800/400',
                    section_name = '내야 프리미엄 구역'
                WHERE event_id = :eid AND name = '프리미엄석'
            """),
            {"eid": KBO_ID},
        )
        await conn.execute(
            text("""
                UPDATE seat_tiers SET
                    view_description = '내야/외야 지정좌석. 전체 그라운드 조망 가능. 응원 열기를 만끽하는 좌석.',
                    distance_from_stage = 30,
                    position_label = '내야/외야 지정석',
                    view_image_url = 'https://picsum.photos/seed/sajik-general/800/400',
                    section_name = '일반 관람 구역'
                WHERE event_id = :eid AND name = '일반석'
            """),
            {"eid": KBO_ID},
        )
        print("✅ KBO 좌석 시야 정보 업데이트 완료")

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # 2. IU HEREH 앙코르 콘서트
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        iu_description = (
            "IU의 역대급 월드투어 'HEREH'의 서울 앙코르 공연!\n\n"
            "🎵 공연 소개\n"
            "전 세계 50만 관객을 사로잡은 HEREH 월드투어가\n"
            "서울 KSPO DOME에서 감동의 앙코르 무대를 펼칩니다.\n"
            "신곡부터 레전드 히트곡까지, IU만이 선사할 수 있는\n"
            "감성과 라이브 퍼포먼스를 경험하세요.\n\n"
            "🌟 이번 앙코르만의 특별함\n"
            "• 서울 한정 스페셜 셋리스트 (월드투어 미공개곡 포함)\n"
            "• 밴드 라이브 + 오케스트라 협연 (특별 편성)\n"
            "• 앙코르 한정 포토카드 & 실버 라이트스틱 (현장 판매)\n"
            "• 무대 연출 업그레이드: 워터스크린 + 홀로그램 연출 추가\n\n"
            "🎤 IU 프로필\n"
            "• 본명: 이지은\n"
            "• 데뷔: 2008년 'Lost and Found'\n"
            "• 대표곡: 좋은 날, 밤편지, Blueming, Celebrity, Love wins all\n"
            "• 수상: 대한민국 대중문화예술상 대통령 표창, 골든디스크 대상 등\n\n"
            "💜 유애나를 위한 팬 서비스\n"
            "• VIP 사운드체크 관람 (리허설 1곡)\n"
            "• 전 좌석 앙코르 기념 포토카드 1매 증정\n"
            "• 럭키석 당첨 시 사인 폴라로이드 증정\n"
            "• 공연 종료 후 IU 자필 메시지 스크린 상영"
        )

        iu_notice = (
            "📢 필독 안내사항\n\n"
            "• 공연 당일 신분증 지참 필수 (본인 확인 후 입장)\n"
            "• VIP석은 사운드체크 포함 — 별도 입장 라인 16:00부터\n"
            "• 일반 입장은 17:00부터 시작\n"
            "• 공연장 내 전문 촬영 장비(DSLR, 미러리스) 반입 불가\n"
            "• 스마트폰 촬영은 허용 (플래시/삼각대 금지)\n"
            "• 응원봉: 공식 실버 라이트스틱 권장 (타 그룹 봉 사용 자제)\n"
            "• 재입장 불가\n"
            "• 우천 시에도 정상 진행 (실내 공연장)\n"
            "• 공연 시작 후 30분 경과 시 취소/환불 불가\n"
            "• 화환/선물: 공연장 로비 지정 구역에 전달 (무대 반입 불가)"
        )

        iu_parking = (
            "🚗 주차 안내\n\n"
            "• 올림픽공원 P2, P3 주차장 이용 (약 2,000대)\n"
            "• 주차 요금: 최초 30분 1,200원, 이후 10분당 500원\n"
            "• 공연일 만차 예상 — 대중교통 이용 강력 권장\n"
            "• 장애인 주차: P2 입구 좌측 전용 구역\n\n"
            "🚇 대중교통\n"
            "• 지하철 5호선 올림픽공원역 3번 출구 → KSPO DOME 도보 10분\n"
            "• 지하철 9호선 한성백제역 1번 출구 → 도보 15분\n"
            "• 지하철 2호선 잠실역 → 셔틀버스 환승\n\n"
            "🚌 셔틀버스\n"
            "• 잠실역 8번 출구에서 15:30~17:30 운행 (편도 1,000원)\n"
            "• 공연 종료 후 30분간 복귀 셔틀 운행\n\n"
            "🚖 택시/라이드\n"
            "• 올림픽공원 정문 하차 → KSPO DOME 안내 표지판 따라 이동\n"
            "• 공연 후 택시 승차장: P3 주차장 옆 지정 구역"
        )

        iu_program_notes = (
            "🎶 셋리스트 힌트 & 프로그램\n\n"
            "[사운드체크] VIP 전용 (16:00~16:30)\n"
            "— 리허설 1곡 공개 관람\n"
            "— VIP 전용 포토타임\n\n"
            "[1부] HEREH: The Beginning (약 50분)\n"
            "— 오프닝 VCR: 'Here I Am'\n"
            "— Love wins all / Shopper / Holssi\n"
            "— 드라마 OST 메들리 (나의 아저씨, 호텔 델루나, 나의 해방일지)\n"
            "— Celebrity / BBIBBI\n"
            "— 밴드 라이브: Blueming (풀밴드 ver.)\n\n"
            "[인터미션] 15분 — 스페셜 VCR + 유애나 응원 메시지 상영\n\n"
            "[2부] HEREH: The Journey (약 50분)\n"
            "— 밤편지 (오케스트라 협연) ★\n"
            "— 좋은 날 / 너의 의미 / 팔레트\n"
            "— 워터스크린 연출: 스물셋\n"
            "— 신곡 (서울 앙코르 최초 공개) 🔥\n"
            "— Through the Night / above the time\n\n"
            "[앙코르] 약 30분\n"
            "— Peach / Strawberry Moon\n"
            "— 떼창: 라일락\n"
            "— 홀로그램 연출: dlwlrma\n"
            "— 자필 메시지 스크린 상영\n"
            "— 마지막 인사 + 단체 사진"
        )

        iu_stage_info = (
            "🎪 무대 & 좌석 안내 — KSPO DOME\n\n"
            "[VIP석]\n"
            "— FLOOR 정면 스탠딩 최전방\n"
            "— 사운드체크 리허설 1곡 관람 포함\n"
            "— 전용 입장 라인 (16:00~)\n"
            "— IU 근접 1~5m\n"
            "— 앙코르 한정 실버 포토카드 1매 추가 증정\n\n"
            "[R석]\n"
            "— FLOOR 후방 + 1층 지정좌석\n"
            "— 메인 스테이지 + 센터 무대(꽃길) 근접\n"
            "— 균형 잡힌 사운드와 시야\n\n"
            "[S석] (현재 미개설)\n"
            "— 2층 지정좌석\n"
            "— 전체 무대 + 워터스크린/홀로그램 연출 최적 조망\n\n"
            "※ 센터 무대(꽃길): 메인→객석 중앙까지 연장\n"
            "※ 워터스크린: 스테이지 양쪽 분수 + 레이저\n"
            "※ 홀로그램: 앙코르 dlwlrma 특별 연출\n"
            "※ LED 스크린: 좌/우/후면 3면 + 천장 무빙라이트"
        )

        iu_program_data = json.dumps({
            "soundcheck": "16:00 (VIP 전용)",
            "doors_open": "17:00",
            "show_start": "18:00",
            "intermission": "19:00 (15분)",
            "part2_start": "19:15",
            "encore": "20:05",
            "expected_end": "20:35",
            "setlist_hint": "Love wins all, Blueming, 밤편지, 좋은 날, Celebrity, 라일락 등",
        })

        iu_tags = json.dumps(["IU", "아이유", "HEREH", "앙코르", "콘서트", "서울", "K-POP", "솔로"])

        iu_desc_images = json.dumps([
            "https://picsum.photos/seed/iu-hereh-stage/1200/800",
            "https://picsum.photos/seed/iu-hereh-crowd/1200/800",
            "https://picsum.photos/seed/iu-hereh-closeup/1200/800",
            "https://picsum.photos/seed/kspo-dome-interior/1200/800",
            "https://picsum.photos/seed/iu-hereh-lightstick/1200/800",
        ])

        iu_ticket_display = json.dumps({
            "includes": [
                "공연 관람",
                "앙코르 기념 포토카드 1매 (전석)",
                "VIP: 사운드체크 리허설 1곡 관람",
                "VIP: 실버 포토카드 1매 추가",
                "럭키석 당첨 시 사인 폴라로이드",
            ],
            "not_includes": [
                "주차비",
                "식음료",
                "공식 굿즈/라이트스틱 (현장 별도 구매)",
            ],
            "exchange_info": "모바일 QR 티켓 → 현장 부스에서 기념 포토카드 교환",
            "entry_info": "VIP 16:00 / 일반 17:00 / 공연 시작 18:00",
        })

        iu_cancel_tiers = json.dumps([
            {"days_before": 10, "fee_pct": 0},
            {"days_before": 7, "fee_pct": 10},
            {"days_before": 3, "fee_pct": 30},
            {"days_before": 1, "fee_pct": 50},
            {"days_before": 0, "fee_pct": 100},
        ])

        iu_discount = json.dumps([
            {
                "type": "fanclub",
                "name": "유애나 팬클럽 할인",
                "discount_pct": 10,
                "description": "공식 팬클럽 UAENA 정회원 인증 시",
            },
            {
                "type": "early_bird",
                "name": "얼리버드",
                "discount_pct": 5,
                "description": "1차 오픈 선착순 1,000명",
            },
        ])

        await conn.execute(
            text("""
                UPDATE events SET
                    description = :description,
                    sub_category = 'K-POP 솔로',
                    notice = :notice,
                    parking_info = :parking,
                    program_notes = :prog_notes,
                    stage_info = :stage,
                    program_data = :prog_data,
                    tags = :tags,
                    description_images = :desc_images,
                    ticket_display_info = :ticket_info,
                    cancellation_fee_tiers = :cancel_tiers,
                    discount_policies = :discount,
                    board_types = :board_types,
                    duration_minutes = 155,
                    age_restriction = '8세 이상',
                    age_rating = '8세 이상 관람가',
                    event_date_end = event_date + interval '2 hours 35 minutes',
                    total_seats = 500,
                    participant_enabled = true
                WHERE id = :id
            """),
            {
                "id": IU_ID,
                "description": iu_description,
                "notice": iu_notice,
                "parking": iu_parking,
                "prog_notes": iu_program_notes,
                "stage": iu_stage_info,
                "prog_data": iu_program_data,
                "tags": iu_tags,
                "desc_images": iu_desc_images,
                "ticket_info": iu_ticket_display,
                "cancel_tiers": iu_cancel_tiers,
                "discount": iu_discount,
                "board_types": json.dumps(["free", "review", "photo"]),
            },
        )
        print("✅ IU HEREH 앙코르 콘서트 상세정보 업데이트 완료")

        # IU tier updates
        await conn.execute(
            text("""
                UPDATE seat_tiers SET
                    view_description = 'FLOOR 정면 최전방 스탠딩. 사운드체크 포함. IU 1~5m 근접. 실버 포토카드 추가 증정.',
                    distance_from_stage = 3,
                    position_label = 'FLOOR 정면 (VIP)',
                    view_image_url = 'https://picsum.photos/seed/kspo-iu-vip/800/400',
                    section_name = 'FLOOR VIP 구역'
                WHERE event_id = :eid AND name = 'VIP석'
            """),
            {"eid": IU_ID},
        )
        await conn.execute(
            text("""
                UPDATE seat_tiers SET
                    view_description = 'FLOOR 후방 + 1층 지정좌석. 센터 무대(꽃길) 근접. 균형 잡힌 사운드와 시야.',
                    distance_from_stage = 20,
                    position_label = 'FLOOR 후방 / 1층 (R석)',
                    view_image_url = 'https://picsum.photos/seed/kspo-iu-r/800/400',
                    section_name = '1층 지정석'
                WHERE event_id = :eid AND name = 'R석'
            """),
            {"eid": IU_ID},
        )
        print("✅ IU 좌석 시야 정보 업데이트 완료")

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # 2.5. KBO 올스타전 → 선착순 모드로 변경
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        await conn.execute(
            text("UPDATE seat_tiers SET sale_mode = 'fixed_fcfs' WHERE event_id = :eid"),
            {"eid": KBO_ID},
        )
        print("✅ KBO 올스타전 → 선착순(fixed_fcfs) 모드로 변경 완료")

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # 3. ITZY BORN TO BE ENCORE — 멤버십 선판매(fanclub_presale)
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        # 팬클럽 생성 (MIDZY)
        await conn.execute(
            text("""
                INSERT INTO fanclubs (id, name, artist_name, description, organizer_id, max_members, is_official, is_active, community_type, domain, created_at, updated_at)
                VALUES (:id, :name, :artist_name, :description, :organizer_id, :max_members, true, true, 'fanclub', 'concert', NOW() - INTERVAL '180 days', NOW() - INTERVAL '1 day')
                ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
            """),
            {
                "id": MIDZY_FANCLUB_ID,
                "name": "MIDZY 공식 팬클럽",
                "artist_name": "ITZY",
                "description": "ITZY 공식 팬 커뮤니티 MIDZY입니다. 멤버십 회원에게 콘서트 선판매 혜택이 제공됩니다.",
                "organizer_id": ORGANIZER_ID,
                "max_members": 50000,
            },
        )
        print("✅ MIDZY 팬클럽 생성 완료")

        itzy_description = (
            "ITZY 2026 앙코르 콘서트 \"BORN TO BE\" 서울 공연!\n\n"
            "🎤 공연 정보\n"
            "• 멤버십(MIDZY) 회원 대상 선판매 진행\n"
            "• 일반 판매에 앞서 팬클럽 회원에게 우선 구매 기회를 드립니다.\n\n"
            "🎵 예상 셋리스트\n"
            "• WANNABE / LOCO / SNEAKERS / CAKE / UNTOUCHABLE\n"
            "• 신곡 무대 최초 공개 예정\n\n"
            "💖 팬클럽 선판매 혜택\n"
            "• MIDZY 멤버십 회원 전용 10% 할인\n"
            "• VIP석 구매 시 사운드체크 리허설 관람 포함\n"
            "• 전석 포토카드 랜덤 1종 증정"
        )

        itzy_notice = (
            "📢 멤버십 선판매 안내\n\n"
            "• MIDZY 멤버십 회원만 구매 가능합니다.\n"
            "• 회원 1인당 최대 4매까지 구매 가능합니다.\n"
            "• 멤버십 할인 10%가 자동 적용됩니다.\n"
            "• 선판매 기간 종료 후 잔여석은 일반 판매로 전환됩니다.\n\n"
            "⚠️ 유의사항\n"
            "• 결제 완료 후 3일 이내 취소 시 전액 환불\n"
            "• 공연 7일 전부터 취소 수수료 10% 부과\n"
            "• 타인 양도 및 교환은 불가합니다."
        )

        itzy_tags = json.dumps(["ITZY", "MIDZY", "콘서트", "서울", "올림픽공원", "K-POP", "멤버십선판매"])

        itzy_ticket_display = json.dumps({
            "includes": [
                "공연 관람 (약 150분)",
                "포토카드 랜덤 1종",
                "VIP석: 사운드체크 리허설 관람",
                "멤버십 10% 할인 적용",
            ],
            "not_includes": ["주차비", "매점 식음료", "굿즈 별도 구매"],
        })

        itzy_cancel_tiers = json.dumps([
            {"days_before": 7, "fee_pct": 0, "label": "7일 전 무료취소"},
            {"days_before": 3, "fee_pct": 10, "label": "3일 전 10%"},
            {"days_before": 1, "fee_pct": 30, "label": "1일 전 30%"},
            {"days_before": 0, "fee_pct": 100, "label": "당일 환불불가"},
        ])

        await conn.execute(
            text("""
                INSERT INTO events (
                    id, organizer_id, title, description, venue, event_date,
                    bidding_opens_at, bidding_closes_at, total_seats, min_price, max_price,
                    status, category, image_url, location_city, artist_name,
                    age_restriction, tags, is_featured, bid_count, view_count,
                    duration_minutes, community_id, currency, event_timezone,
                    resale_surplus_recapture_pct, notice, ticket_display_info,
                    cancellation_fee_tiers
                ) VALUES (
                    :id, :organizer_id, :title, :description, :venue, NOW() + INTERVAL '60 days',
                    NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days', 8000, 88000, 264000,
                    'BIDDING_OPEN', 'CONCERT', 'https://picsum.photos/seed/itzy-encore/800/1200',
                    '서울', 'ITZY', '전체 관람가', :tags, true, 3200, 18500,
                    150, :community_id, 'KRW', 'Asia/Seoul',
                    60, :notice, :ticket_display, :cancel_tiers
                )
                ON CONFLICT (id) DO UPDATE SET
                    description = EXCLUDED.description,
                    notice = EXCLUDED.notice,
                    tags = EXCLUDED.tags,
                    ticket_display_info = EXCLUDED.ticket_display_info,
                    cancellation_fee_tiers = EXCLUDED.cancellation_fee_tiers,
                    updated_at = NOW()
            """),
            {
                "id": ITZY_ID,
                "organizer_id": ORGANIZER_ID,
                "title": "ITZY 2026 BORN TO BE ENCORE in SEOUL",
                "description": itzy_description,
                "venue": "KSPO DOME (올림픽공원 체조경기장)",
                "community_id": MIDZY_FANCLUB_ID,
                "tags": itzy_tags,
                "notice": itzy_notice,
                "ticket_display": itzy_ticket_display,
                "cancel_tiers": itzy_cancel_tiers,
            },
        )
        print("✅ ITZY BORN TO BE 이벤트 생성 완료")

        # ITZY 티어 생성
        itzy_tiers = [
            {"id": "f1e2d3c4-b5a6-4978-8901-234567890abc", "name": "VIP석", "capacity": 1500, "price": 264000, "sold": 342, "section": "FLOOR"},
            {"id": "f2e3d4c5-b6a7-4089-9012-345678901bcd", "name": "R석", "capacity": 3000, "price": 176000, "sold": 891, "section": "1F"},
            {"id": "a90d0380-ea91-4d53-b957-d45be60f419e", "name": "S석", "capacity": 2500, "price": 132000, "sold": 567, "section": "2F 앞"},
            {"id": "839b7a0d-18a4-4687-895c-ae0dbcb3b833", "name": "A석", "capacity": 1000, "price": 88000, "sold": 203, "section": "2F 뒤"},
        ]
        for tier in itzy_tiers:
            await conn.execute(
                text("""
                    INSERT INTO seat_tiers (id, event_id, name, capacity, base_price, face_price, sale_mode, fanclub_discount_pct, sold_count, seating_type, max_group_size, bidding_opens_at, bidding_closes_at, section_name)
                    VALUES (:id, :event_id, :name, :capacity, :price, :price, 'fanclub_presale', 10, :sold, 'assigned', 4, NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days', :section)
                    ON CONFLICT (id) DO UPDATE SET
                        sale_mode = 'fanclub_presale',
                        fanclub_discount_pct = 10,
                        section_name = EXCLUDED.section_name,
                        sold_count = EXCLUDED.sold_count
                """),
                {"id": tier["id"], "event_id": ITZY_ID, "name": tier["name"], "capacity": tier["capacity"], "price": tier["price"], "sold": tier["sold"], "section": tier["section"]},
            )
        print("✅ ITZY 티어 4개 생성 완료 (fanclub_presale, 10% 할인)")

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # Verify
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        check_cols = [
            "description", "notice", "parking_info", "program_notes", "stage_info",
            "program_data", "tags", "description_images", "ticket_display_info",
            "cancellation_fee_tiers", "discount_policies", "board_types",
            "sub_category", "age_rating", "duration_minutes", "event_date_end",
        ]
        for eid, label in [(KBO_ID, "KBO 올스타전"), (IU_ID, "IU HEREH"), (ITZY_ID, "ITZY BORN TO BE")]:
            col_checks = ", ".join(
                [f"{c} IS NOT NULL" if c not in ("sub_category", "age_rating", "duration_minutes") else c for c in check_cols]
            )
            r = await conn.execute(
                text(f"SELECT title, {', '.join(check_cols)} FROM events WHERE id = :id"),
                {"id": eid},
            )
            row = r.fetchone()
            print(f"\n{'='*50}")
            print(f"  {label}: {row[0]}")
            for i, c in enumerate(check_cols):
                val = row[i + 1]
                if c in ("sub_category", "age_rating", "duration_minutes"):
                    print(f"  {c}: {val}")
                else:
                    print(f"  {c}: {'✅' if val else '❌'}")

            r2 = await conn.execute(
                text("SELECT name, view_description IS NOT NULL, section_name, distance_from_stage FROM seat_tiers WHERE event_id = :eid"),
                {"eid": eid},
            )
            for t in r2.fetchall():
                print(f"  tier [{t[0]}]: view={'✅' if t[1] else '❌'} section={t[2]} dist={t[3]}m")


asyncio.run(populate())
