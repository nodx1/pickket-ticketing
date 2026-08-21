"""Populate two existing events with rich, complete data."""
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

AESPA_ID = "c2837a39-9a37-43b8-912d-ba9e30a30276"
JAZZ_ID = "cf55761b-a888-42c7-9e49-89cf37331cde"


async def populate():
    async with engine.begin() as conn:
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # AESPA CONCERT
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        aespa_notice = (
            "📢 필독 안내사항\n\n"
            "• 공연 당일 신분증 지참 필수 (본인 확인 후 입장)\n"
            "• 사운드체크 VIP는 별도 입장 라인으로 16:30부터 입장\n"
            "• 일반 입장은 17:00부터 시작\n"
            "• 공연장 내 전문 촬영 장비(DSLR, 미러리스) 반입 불가\n"
            "• 스마트폰 촬영은 허용되나 플래시/삼각대 사용 금지\n"
            "• 응원봉: 공식 라이트스틱만 사용 가능 (배터리 교체용 건전지 준비 권장)\n"
            "• 재입장 불가 — 퇴장 시 재입장 스탬프 별도 문의\n"
            "• 우천 시에도 정상 진행 (KSPO DOME 실내)\n"
            "• 공연 시작 후 30분 경과 시 취소/환불 불가"
        )

        aespa_parking = (
            "🚗 주차 안내\n\n"
            "• 올림픽공원 P2, P3 주차장 이용 (약 2,000대)\n"
            "• 주차 요금: 최초 30분 1,200원, 이후 10분당 500원\n"
            "• 공연일 혼잡 예상 — 대중교통 이용 강력 권장\n"
            "• 장애인 주차: P2 입구 좌측 전용 구역\n\n"
            "🚇 대중교통\n"
            "• 지하철 5호선 올림픽공원역 3번 출구 → 도보 10분\n"
            "• 지하철 9호선 한성백제역 1번 출구 → 도보 15분\n"
            "• 셔틀버스: 잠실역 8번 출구에서 16:00~17:30 운행 (편도 1,000원)\n\n"
            "🚖 택시/라이드\n"
            "• 올림픽공원 정문 하차 → KSPO DOME 안내 따라 이동\n"
            "• 공연 후 택시 승차장: P3 주차장 옆 지정 구역"
        )

        aespa_program_notes = (
            "🎶 셋리스트 힌트 & 프로그램 노트\n\n"
            "[1부] SYNK: ENTER (약 60분)\n"
            "— 오프닝 VCR + XR 퍼포먼스\n"
            "— Supernova / Next Level / Black Mamba\n"
            "— Drama / Better Things / Hold On Tight\n"
            "— 유닛 무대 (카리나&윈터 / 지젤&닝닝)\n"
            "— 솔로 무대 4곡\n"
            "— 신보 타이틀곡 최초 공개 🔥\n\n"
            "[인터미션] 20분 — æ-talk VCR, 포토타임\n\n"
            "[2부] SYNK: PARALLEL (약 60분)\n"
            "— Armageddon / Savage / Girls\n"
            "— Dreams Come True / Forever\n"
            "— 밴드 라이브 세션 (스페셜)\n"
            "— 팬 서프라이즈 이벤트 🎉\n"
            "— Spicy / Thirsty\n"
            "— Life's Too Short (어쿠스틱 ver.)\n\n"
            "[앙코르] 약 30분\n"
            "— Welcome to MY World\n"
            "— 떼창 타임\n"
            "— Yeppi Yeppi / ICU\n"
            "— 엔딩 멘트 + 단체 인사"
        )

        aespa_stage_info = (
            "🎪 무대 & 좌석 안내\n\n"
            "[FLOOR A] VIP 사운드체크석\n"
            "— 메인 스테이지 정면 최전방\n"
            "— 사운드체크 리허설 관람 + 공연 포함\n"
            "— 전용 입장 라인 (16:30~)\n"
            "— VIP 전용 굿즈 교환권 포함\n\n"
            "[FLOOR B-C] R석\n"
            "— 메인 스테이지 정면 스탠딩\n"
            "— 센터 확장 무대(꽃길) 근접\n"
            "— 아티스트 동선 최근접\n\n"
            "[1층 지정석] S석\n"
            "— 1층 좌/우 지정좌석\n"
            "— 시야 양호, 전체 무대 조망\n"
            "— 좌석 번호 지정\n\n"
            "[2층 지정석] A석\n"
            "— 2층 지정좌석\n"
            "— 전체 무대 + XR LED 연출 최적 조망\n"
            "— 가성비 좋은 시야\n\n"
            "※ 센터 확장 무대(꽃길): 메인→객석 중앙까지 연장\n"
            "※ 360도 서브 스테이지: 공연 중 2회 사용 예정\n"
            "※ XR 스크린: 좌/우/후면 3면 LED + 천장 프로젝션"
        )

        aespa_desc_images = json.dumps([
            "https://picsum.photos/seed/aespa-stage-1/1200/800",
            "https://picsum.photos/seed/aespa-stage-2/1200/800",
            "https://picsum.photos/seed/aespa-venue/1200/800",
            "https://picsum.photos/seed/aespa-seatmap/1200/800",
            "https://picsum.photos/seed/aespa-merch/1200/800",
        ])

        aespa_ticket_display = json.dumps({
            "includes": [
                "공연 관람",
                "VIP: 사운드체크 리허설 참관",
                "VIP: 한정 포토카드 1매",
                "기념 티켓 홀더",
            ],
            "not_includes": ["주차비", "식음료", "공식 굿즈 별도 구매"],
            "exchange_info": "현장 티켓 부스에서 모바일 티켓 확인 후 기념 티켓 교환",
            "entry_info": "VIP 16:30 / 일반 17:00 / 공연 시작 18:00",
        })

        aespa_cancel_tiers = json.dumps([
            {"days_before": 10, "fee_pct": 0},
            {"days_before": 7, "fee_pct": 10},
            {"days_before": 3, "fee_pct": 30},
            {"days_before": 1, "fee_pct": 50},
            {"days_before": 0, "fee_pct": 100},
        ])

        aespa_discount = json.dumps([
            {
                "type": "fanclub",
                "name": "MY 멤버십 할인",
                "discount_pct": 10,
                "description": "공식 팬클럽 MY 정회원 인증 시",
            },
            {
                "type": "early_bird",
                "name": "얼리버드",
                "discount_pct": 5,
                "description": "1차 오픈 기간 구매 시 (선착순 2,000명)",
            },
        ])

        await conn.execute(
            text("""
                UPDATE events SET
                    notice = :notice,
                    description_images = :desc_images,
                    parking_info = :parking,
                    program_notes = :prog_notes,
                    stage_info = :stage,
                    sub_category = :sub_cat,
                    age_rating = :age_rating,
                    ticket_display_info = :ticket_info,
                    cancellation_fee_tiers = :cancel_tiers,
                    discount_policies = :discount,
                    board_types = :board_types,
                    nft_enabled = true
                WHERE id = :id
            """),
            {
                "id": AESPA_ID,
                "notice": aespa_notice,
                "desc_images": aespa_desc_images,
                "parking": aespa_parking,
                "prog_notes": aespa_program_notes,
                "stage": aespa_stage_info,
                "sub_cat": "K-POP",
                "age_rating": "8세 이상 관람가",
                "ticket_info": aespa_ticket_display,
                "cancel_tiers": aespa_cancel_tiers,
                "discount": aespa_discount,
                "board_types": json.dumps(["free", "review", "photo"]),
            },
        )
        print("✅ AESPA 추가 정보 업데이트 완료")

        # Seat tier view descriptions — AESPA
        tier_updates = [
            (
                "VIP 사운드체크",
                "메인 스테이지 정면 최전방. 사운드체크 리허설 관람 포함. 아티스트 1m 근접 가능.",
                3,
                "FLOOR A (정면)",
                "https://picsum.photos/seed/kspo-vip-view/800/400",
            ),
            (
                "R석",
                "메인 스테이지 정면 스탠딩. 센터 확장 무대(꽃길) 근접. 역동적인 퍼포먼스 체감.",
                15,
                "FLOOR B-C (스탠딩)",
                "https://picsum.photos/seed/kspo-r-view/800/400",
            ),
            (
                "S석",
                "1층 좌/우 지정좌석. 전체 무대 균형 잡힌 시야. 편안한 관람.",
                45,
                "1층 (좌/우 지정석)",
                "https://picsum.photos/seed/kspo-s-view/800/400",
            ),
            (
                "A석",
                "2층 지정좌석. 무대 전체 + XR LED 연출 최적 조망. 가성비 최고 구역.",
                80,
                "2층 (지정석)",
                "https://picsum.photos/seed/kspo-a-view/800/400",
            ),
        ]
        for name, desc, dist, pos, img in tier_updates:
            await conn.execute(
                text("""
                    UPDATE seat_tiers SET
                        view_description = :desc,
                        distance_from_stage = :dist,
                        position_label = :pos,
                        view_image_url = :img
                    WHERE event_id = :eid AND name = :name
                """),
                {"eid": AESPA_ID, "name": name, "desc": desc, "dist": dist, "pos": pos, "img": img},
            )
        print("✅ AESPA 좌석 시야 정보 업데이트 완료")

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # JAZZ FESTIVAL
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        jazz_notice = (
            "📢 페스티벌 안내사항\n\n"
            "• 3일권은 매일 재입장 가능 (손목 밴드 착용 필수)\n"
            "• 1일권은 해당 일자만 유효, 재입장 1회 가능\n"
            "• 야외 행사 — 우천 시에도 정상 진행 (우비 준비 권장, 우산 사용 제한 구역 있음)\n"
            "• 돗자리/캠핑의자 반입 가능 (지정 구역 내에서만)\n"
            "• 반려동물 동반 불가\n"
            "• 외부 음식물 반입 금지 (장내 F&B 부스 50+개 운영)\n"
            "• 미성년자 주류 구매 불가 (신분증 확인)\n"
            "• VIP 라운지: 전용 입장, 프리미엄 좌석, 웰컴 드링크, 아티스트 사인회 우선 참여\n"
            "• 분실물 센터: 본부석 옆 안내 텐트"
        )

        jazz_parking = (
            "🚗 주차 안내\n\n"
            "• 올림픽공원 P1~P5 주차장 이용 (총 약 4,500대)\n"
            "• 페스티벌 기간 특별 요금: 1일 15,000원 (정산)\n"
            "• 3일 연속 주차 시 40,000원 할인 가격\n"
            "• 만차 시 인근 방이동 공영주차장 이용\n\n"
            "🚇 대중교통\n"
            "• 5호선 올림픽공원역 3번 출구 → 잔디마당 도보 7분\n"
            "• 9호선 한성백제역 1번 출구 → 도보 12분\n"
            "• 2호선 잠실역 → 마을버스 3413 → 올림픽공원 하차\n\n"
            "🚌 셔틀버스\n"
            "• 강남역 / 홍대입구역 / 서울역에서 페스티벌 셔틀 운행\n"
            "• 왕복 5,000원 (사전 예약제, pickket.com에서 구매)\n"
            "• 운행 시간: 축제 시작 2시간 전 ~ 종료 1시간 후"
        )

        jazz_prog_notes = (
            "🎶 3일간의 프로그램\n\n"
            "━━━ DAY 1 (7/25 금) ━━━\n"
            "11:00-12:00  재즈 워크숍 — \"즉흥 연주의 기초\" (잔디 스테이지)\n"
            "12:00-13:00  이날치\n"
            "13:30-14:30  국카스텐\n"
            "15:00-16:00  브로콜리너마저\n"
            "16:30-17:30  Yaeji (야에지)\n"
            "18:00-19:00  Tom Misch\n"
            "19:30-20:00  DJ 세션\n"
            "20:00-22:00  ★ Norah Jones (헤드라이너)\n\n"
            "━━━ DAY 2 (7/26 토) ━━━\n"
            "11:00-12:00  재즈 마스터클래스 — \"보컬 표현법\" (잔디 스테이지)\n"
            "12:00-13:00  소란\n"
            "13:30-14:30  새소년\n"
            "15:00-16:00  Balming Tiger\n"
            "16:30-17:30  Thundercat\n"
            "18:00-19:00  Jorja Smith\n"
            "19:30-20:00  DJ 세션\n"
            "20:00-22:00  ★ Khruangbin (헤드라이너)\n\n"
            "━━━ DAY 3 (7/27 일) ━━━\n"
            "11:00-12:00  재즈 마스터클래스 — \"리듬 섹션\" (잔디 스테이지)\n"
            "12:00-13:00  잔나비\n"
            "13:30-14:30  혁오\n"
            "15:00-16:00  Sunset Rollercoaster\n"
            "16:30-17:30  Mac DeMarco\n"
            "18:00-19:00  Hiatus Kaiyote\n"
            "19:30-20:00  DJ 세션 + 서프라이즈 게스트\n"
            "20:00-21:30  ★ Robert Glasper (클로징)\n\n"
            "📍 스테이지: 메인 스테이지 / 잔디 스테이지 / DJ 라운지 / VIP 라운지"
        )

        jazz_stage_info = (
            "🎪 공간 안내\n\n"
            "[메인 스테이지]\n"
            "— 88잔디마당 중앙 대형 스테이지\n"
            "— LED 스크린 좌/우 2면\n"
            "— 스탠딩 + 잔디 구역\n\n"
            "[잔디 스테이지]\n"
            "— 메인 스테이지 옆 소규모 무대\n"
            "— 워크숍/마스터클래스/어쿠스틱 세션\n\n"
            "[DJ 라운지]\n"
            "— 공연 전환 시간 DJ 세트\n"
            "— 야간 애프터파티 (22:00~23:30, DAY 2 한정)\n\n"
            "[VIP 라운지]\n"
            "— 메인 스테이지 전면 전용 구역\n"
            "— 프리미엄 좌석 (빈백 + 파라솔)\n"
            "— 전용 바 & 케이터링\n"
            "— 아티스트 사인회 우선 참여\n\n"
            "[F&B 존]\n"
            "— 50+ 부스: 크래프트 맥주, 와인, 칵테일\n"
            "— 푸드트럭 20+: 한식/양식/아시안/디저트\n"
            "— 비건/할랄 옵션 표시\n\n"
            "[편의시설]\n"
            "— 수유실, 장애인 관람 구역, 의무실\n"
            "— 무료 물 리필 스테이션 3곳\n"
            "— 휴대폰 충전 부스"
        )

        jazz_desc_images = json.dumps([
            "https://picsum.photos/seed/jazz-fest-main/1200/800",
            "https://picsum.photos/seed/jazz-fest-crowd/1200/800",
            "https://picsum.photos/seed/jazz-fest-food/1200/800",
            "https://picsum.photos/seed/jazz-fest-night/1200/800",
            "https://picsum.photos/seed/jazz-fest-vip/1200/800",
        ])

        jazz_ticket_display = json.dumps({
            "includes": [
                "공연 관람",
                "3일권: 매일 재입장 가능",
                "VIP: 전용 라운지 이용",
                "VIP: 웰컴 드링크 1잔",
                "VIP: 아티스트 사인회 우선 참여",
            ],
            "not_includes": [
                "주차비 (1일 15,000원)",
                "식음료 (장내 부스 구매)",
                "돗자리/캠핑의자 (개인 지참)",
            ],
            "exchange_info": "QR 모바일 티켓 → 현장 부스에서 손목 밴드 교환 (3일권: 3일용 밴드)",
            "entry_info": "VIP 10:00 / 일반 10:30 / 공연 시작 11:00",
        })

        jazz_cancel_tiers = json.dumps([
            {"days_before": 14, "fee_pct": 0},
            {"days_before": 7, "fee_pct": 10},
            {"days_before": 3, "fee_pct": 30},
            {"days_before": 1, "fee_pct": 50},
            {"days_before": 0, "fee_pct": 100},
        ])

        jazz_discount = json.dumps([
            {
                "type": "early_bird",
                "name": "얼리버드 할인",
                "discount_pct": 15,
                "description": "얼리버드 3일권 (선착순 3,000명, 매진)",
            },
            {
                "type": "group",
                "name": "그룹 할인",
                "discount_pct": 10,
                "description": "4인 이상 동시 구매 시",
            },
            {
                "type": "student",
                "name": "대학생 할인",
                "discount_pct": 20,
                "description": "1일권 한정, 학생증 인증 필수",
            },
        ])

        await conn.execute(
            text("""
                UPDATE events SET
                    notice = :notice,
                    description_images = :desc_images,
                    parking_info = :parking,
                    program_notes = :prog_notes,
                    stage_info = :stage,
                    sub_category = :sub_cat,
                    age_rating = :age_rating,
                    ticket_display_info = :ticket_info,
                    cancellation_fee_tiers = :cancel_tiers,
                    discount_policies = :discount,
                    board_types = :board_types,
                    participant_enabled = true
                WHERE id = :id
            """),
            {
                "id": JAZZ_ID,
                "notice": jazz_notice,
                "desc_images": jazz_desc_images,
                "parking": jazz_parking,
                "prog_notes": jazz_prog_notes,
                "stage": jazz_stage_info,
                "sub_cat": "재즈/소울",
                "age_rating": "7세 이상 관람가",
                "ticket_info": jazz_ticket_display,
                "cancel_tiers": jazz_cancel_tiers,
                "discount": jazz_discount,
                "board_types": json.dumps(["free", "review", "photo", "trade"]),
            },
        )
        print("✅ 재즈 페스티벌 추가 정보 업데이트 완료")

        # Jazz tier view descriptions
        await conn.execute(
            text("""
                UPDATE seat_tiers SET
                    view_description = :desc,
                    distance_from_stage = 8,
                    position_label = 'VIP 라운지 (정면)',
                    view_image_url = 'https://picsum.photos/seed/jazz-vip-view/800/400',
                    seating_type = 'free',
                    section_name = 'VIP 라운지'
                WHERE event_id = :eid AND name = 'VIP 라운지 3일권'
            """),
            {
                "eid": JAZZ_ID,
                "desc": "VIP 전용 프리미엄 구역. 메인 스테이지 정면 최전방 빈백석. 전용 바/케이터링, 아티스트 사인회 우선 참여.",
            },
        )

        for name in ["얼리버드 3일권", "일반 3일권"]:
            await conn.execute(
                text("""
                    UPDATE seat_tiers SET
                        view_description = :desc,
                        seating_type = 'free',
                        section_name = '잔디 일반 구역'
                    WHERE event_id = :eid AND name = :name
                """),
                {
                    "eid": JAZZ_ID,
                    "name": name,
                    "desc": f"{'얼리버드 특가 ' if '얼리' in name else ''}3일간 자유석 관람. 잔디 구역 어디서든 편하게 즐기는 페스티벌.",
                },
            )

        for day_name, day_label in [
            ("1일권 (금)", "금요일"),
            ("1일권 (토)", "토요일"),
            ("1일권 (일)", "일요일"),
        ]:
            await conn.execute(
                text("""
                    UPDATE seat_tiers SET
                        view_description = :desc,
                        seating_type = 'free',
                        section_name = '잔디 일반 구역'
                    WHERE event_id = :eid AND name = :name
                """),
                {
                    "eid": JAZZ_ID,
                    "name": day_name,
                    "desc": f"{day_label} 한정 1일 자유석. 해당 일자 공연만 관람 가능.",
                },
            )

        print("✅ 재즈 페스티벌 좌석 정보 업데이트 완료")

        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        # Verify
        # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        for eid, label in [(AESPA_ID, "AESPA"), (JAZZ_ID, "JAZZ")]:
            r = await conn.execute(
                text("""
                    SELECT title, notice IS NOT NULL, parking_info IS NOT NULL,
                           program_notes IS NOT NULL, stage_info IS NOT NULL,
                           description_images IS NOT NULL, ticket_display_info IS NOT NULL,
                           cancellation_fee_tiers IS NOT NULL, discount_policies IS NOT NULL,
                           sub_category, age_rating, board_types IS NOT NULL
                    FROM events WHERE id = :id
                """),
                {"id": eid},
            )
            row = r.fetchone()
            print(f"\n{'='*50}")
            print(f"  {label}: {row[0]}")
            print(f"  notice: {'✅' if row[1] else '❌'}")
            print(f"  parking: {'✅' if row[2] else '❌'}")
            print(f"  program_notes: {'✅' if row[3] else '❌'}")
            print(f"  stage_info: {'✅' if row[4] else '❌'}")
            print(f"  desc_images: {'✅' if row[5] else '❌'}")
            print(f"  ticket_display: {'✅' if row[6] else '❌'}")
            print(f"  cancel_tiers: {'✅' if row[7] else '❌'}")
            print(f"  discount: {'✅' if row[8] else '❌'}")
            print(f"  sub_category: {row[9]}")
            print(f"  age_rating: {row[10]}")
            print(f"  board_types: {'✅' if row[11] else '❌'}")

            r2 = await conn.execute(
                text("""
                    SELECT name, view_description IS NOT NULL, section_name
                    FROM seat_tiers WHERE event_id = :eid
                """),
                {"eid": eid},
            )
            for t in r2.fetchall():
                print(f"  tier [{t[0]}]: view={'✅' if t[1] else '❌'}, section={t[2]}")


asyncio.run(populate())
