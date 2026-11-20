from fastapi import APIRouter, Depends

from app.api.v1 import auth, events, bids, allocations, users, notifications, organizer
from app.api.v1 import purchase, tiers, lottery, waitlist, tickets, orders
from app.api.v1 import resale
from app.api.v1 import transfers
from app.api.v1 import venues, seats, sessions
from app.api.v1 import queue
from app.api.v1 import checkin, public_events, nft, facilities, proxy_booking, reports
from app.api.v1 import points
from app.api.v1 import quests
from app.api.v1 import badges
from app.api.v1 import shop
from app.api.v1 import fanclubs, groups
from app.api.v1 import rehearsal
from app.api.v1 import admin as admin_api
from app.api.v1 import health as health_api
from app.api.v1 import domain_config as domain_config_api
from app.api.v1 import organizer_onboarding, organizer_requests, open_notices
from app.api.v1 import participants, discounts, final_calls, packages
from app.api.v1 import ticket_issuance, organizer_community
from app.api.v1 import promotions, bridge_pages, partnerships
from app.api.v1 import partners
from app.api.v1 import uploads
from app.api.v1 import reviews
from app.api.v1 import public as public_api
from app.api.v1 import public_data, time_slots
from app.api.v1 import public_intent
from app.api.v1 import image_status
from app.api.v1 import metrics
from app.api.v1 import survey
from app.api.v1 import follows
from app.api.v1 import event_pages
from app.api.v1 import event_comments
from app.api.v1 import artist_messages
from app.api.v1 import fan_letters
from app.api.v1 import sse
from app.api.v1 import anticipation_sessions
from app.api.v1 import digital_photocards
from app.api.v1 import analytics as analytics_api
from app.api.v1 import custom_domains
from app.api.v1 import ab_tests
from app.api.v1 import fan_requests
from app.api.v1 import eda_test
from app.api.v1 import tracking as tracking_api
from app.api.v1 import push as push_api
from app.api.v1 import price_alerts as price_alerts_api
from app.api.v1 import geofences as geofences_api
from app.api.v1 import friendships as friendships_api
from app.api.v1 import cs as cs_api
from app.api.v1 import bot as bot_api
from app.api.v1 import chat as chat_api
from app.api.v1 import billing
from app.api.v1 import delegation
from app.api.v1 import funnel as funnel_api
from app.api.v1 import admin_settlements
from app.api.v1 import discover as discover_api
from app.api.v1 import sync as sync_api
from app.api.v1 import admin_roles
from app.api.v1 import webhooks as outbound_webhooks
from app.api.v1 import moderation as moderation_api
from app.api.v1 import chargebacks as chargebacks_api
from app.api.v1 import cohort as cohort_api
from app.api.v1 import recommendations as recommendations_api
from app.api.v1 import post_event
from app.api.v1 import traffic_monitor
from app.api.v1 import admin_slo
from app.api.v1 import event_open_subscriptions
from app.api.v1 import internal_sync
from app.api.v1 import fairness as fairness_api  # 과업 WP1·WP4
from app.api.v1 import onsite as onsite_api  # 과업 WP6·WP7
from app.api.v1 import maps as maps_api  # 과업지시서 2-1 지도 API 연동
from app.api.v1 import ops as ops_board
from app.api.v1 import internal_commerce
from app.api.v1 import internal_commerce_read
from app.api.v1 import internal_organizer_account
from app.api.v1 import internal_organizer_team
from app.api.v1 import internal_hosts
from app.api.v1 import internal_organizer_content
from app.api.v1 import internal_waitlist
from app.api.v1 import internal_messaging
from app.api.v1 import internal_support
from app.api.v1 import guests
from app.api.v1.password_reset import router as password_reset_router
from app.api.v1.payment_webhook import router as webhook_router
from app.api.v1.waiting_room import router as waiting_room_router
from app.middleware.rate_limit import rate_limit_auth, rate_limit_bid, rate_limit_upload

api_router = APIRouter()
api_router.include_router(
    auth.router, prefix="/auth", tags=["auth"], dependencies=[Depends(rate_limit_auth)]
)
api_router.include_router(bot_api.router, prefix="", tags=["bot-detection"])
api_router.include_router(lottery.router, prefix="/events", tags=["lottery"])  # lottery 먼저 (my-lottery-history가 /{event_id}에 안 잡히게)
api_router.include_router(events.router, prefix="/events", tags=["events"])
api_router.include_router(time_slots.router, prefix="/events", tags=["time-slots"])
api_router.include_router(
    bids.router, prefix="/events", tags=["bids"], dependencies=[Depends(rate_limit_bid)]
)
api_router.include_router(allocations.router, prefix="/events", tags=["allocations"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(notifications.router, prefix="/notifications", tags=["notifications"])
api_router.include_router(organizer.router, prefix="/organizer", tags=["organizer"])
api_router.include_router(
    purchase.router, prefix="/events", tags=["purchase"], dependencies=[Depends(rate_limit_bid)]
)
api_router.include_router(tiers.router, prefix="/events", tags=["tiers"])
api_router.include_router(lottery.router, prefix="/lottery", tags=["lottery"])
api_router.include_router(waitlist.router, prefix="/events", tags=["waitlist"])
api_router.include_router(
    event_open_subscriptions.router, prefix="/events", tags=["event-open-subscriptions"],
    dependencies=[Depends(rate_limit_auth)],
)
api_router.include_router(tickets.router, prefix="/tickets", tags=["tickets"])
api_router.include_router(orders.router, prefix="/orders", tags=["orders"])
api_router.include_router(guests.router, prefix="/guests", tags=["guests"])
api_router.include_router(resale.router, prefix="/resale", tags=["resale"])
api_router.include_router(transfers.router, prefix="/transfers", tags=["transfers"])
api_router.include_router(venues.router, prefix="/venues", tags=["venues"])
api_router.include_router(seats.router, prefix="/events", tags=["seats"])
api_router.include_router(sessions.router, prefix="/events", tags=["sessions"])
api_router.include_router(queue.router, prefix="/events", tags=["queue"])
api_router.include_router(checkin.router, prefix="/events", tags=["checkin"])
api_router.include_router(public_events.router, prefix="", tags=["public_events"])
# NFT endpoints disabled — mint_nft/claim_nft raise NotImplementedError
# api_router.include_router(nft.router, prefix="", tags=["nft"])
api_router.include_router(facilities.router, prefix="", tags=["facilities"])
api_router.include_router(proxy_booking.router, prefix="", tags=["proxy-booking"])
api_router.include_router(reports.router, prefix="", tags=["reports"])
api_router.include_router(points.router, prefix="/points", tags=["points"])
api_router.include_router(
    password_reset_router,
    prefix="/auth",
    tags=["auth"],
    dependencies=[Depends(rate_limit_auth)],
)
api_router.include_router(webhook_router, tags=["webhooks"])
api_router.include_router(waiting_room_router, tags=["waiting-room"])
api_router.include_router(fanclubs.router, prefix="/fanclubs", tags=["fanclubs"])
api_router.include_router(groups.router, prefix="/groups", tags=["groups"])
api_router.include_router(rehearsal.router, prefix="", tags=["rehearsal"])
api_router.include_router(admin_api.router, prefix="", tags=["admin"])
api_router.include_router(health_api.router, prefix="", tags=["health"])
api_router.include_router(domain_config_api.router, prefix="", tags=["domain-config"])

# Organizer portal routers
api_router.include_router(
    organizer_onboarding.router, prefix="/organizer", tags=["organizer-onboarding"]
)
api_router.include_router(
    organizer_onboarding.government_router,
    prefix="/organizers",
    tags=["government-organizers"],
)
api_router.include_router(
    organizer_requests.router, prefix="/organizer/requests", tags=["organizer-requests"]
)
api_router.include_router(
    organizer_community.router, prefix="/organizer", tags=["organizer-community"]
)
api_router.include_router(open_notices.router, prefix="/open-notices", tags=["open-notices"])
api_router.include_router(participants.router, prefix="/events", tags=["participants"])
api_router.include_router(discounts.router, prefix="/events", tags=["discounts"])
api_router.include_router(final_calls.router, prefix="/organizer/final-calls", tags=["final-calls"])
api_router.include_router(packages.router, prefix="/organizer/packages", tags=["packages"])
api_router.include_router(
    ticket_issuance.router, prefix="/organizer/ticket-issuance", tags=["ticket-issuance"]
)
api_router.include_router(promotions.router, prefix="/organizer/promotions", tags=["promotions"])
api_router.include_router(
    bridge_pages.router, prefix="/organizer/bridge-pages", tags=["bridge-pages"]
)
api_router.include_router(
    bridge_pages.public_router, prefix="/bridge-pages", tags=["bridge-pages-public"]
)
api_router.include_router(
    partnerships.router, prefix="/organizer/partnerships", tags=["partnerships"]
)
api_router.include_router(partners.router, tags=["partners"])
api_router.include_router(
    uploads.router,
    prefix="/uploads",
    tags=["uploads"],
    dependencies=[Depends(rate_limit_upload)],
)
api_router.include_router(image_status.router, prefix="", tags=["images"])
api_router.include_router(reviews.router, prefix="/events", tags=["reviews"])
api_router.include_router(public_api.router, prefix="/public", tags=["public"])
# 트랙B U3 — 공개 랜딩 부속기능(RSVP·단체예약) 수신(인증 없음, 봇방지+rate_limit).
api_router.include_router(public_intent.router, prefix="/public", tags=["public-intent"])
api_router.include_router(public_data.router, prefix="/public-data", tags=["public-data"])

# WP14: Gamification (quests, badges, attendance)
api_router.include_router(quests.router, prefix="/quests", tags=["quests"])
api_router.include_router(badges.router, prefix="/badges", tags=["badges"])

# WP09/WP15: AP Shop
api_router.include_router(shop.router, prefix="/shop", tags=["shop"])

# Web Vitals RUM metrics
api_router.include_router(metrics.router, prefix="", tags=["metrics"])

# Survey
api_router.include_router(survey.router, prefix="", tags=["surveys"])

# Follow system
api_router.include_router(follows.router, prefix="/follows", tags=["follows"])

# Event comments (community feed)
api_router.include_router(event_comments.router, prefix="/events", tags=["event-comments"])

# Event pages (subdomain)
api_router.include_router(event_pages.router, prefix="/events", tags=["event-pages"])

# Artist messages (Weverse-style)
api_router.include_router(artist_messages.router, prefix="/events", tags=["artist-messages"])

# Fan letters
api_router.include_router(fan_letters.router, prefix="/events", tags=["fan-letters"])

# SSE: real-time event stats
api_router.include_router(sse.router, prefix="/events", tags=["sse"])

# Anticipation sessions (같이 기대하기)
api_router.include_router(
    anticipation_sessions.router, prefix="/events", tags=["anticipation-sessions"]
)
api_router.include_router(
    anticipation_sessions.router, prefix="/anticipation-sessions", tags=["anticipation-sessions"]
)

# Digital photocards
api_router.include_router(digital_photocards.router, prefix="", tags=["digital-photocards"])

# Event analytics dashboard
api_router.include_router(analytics_api.router, prefix="/events", tags=["analytics"])

# Custom domain mapping
api_router.include_router(
    custom_domains.router, prefix="/custom-domains", tags=["custom-domains"]
)

# A/B testing
api_router.include_router(ab_tests.router, prefix="", tags=["ab-tests"])

# Fan requests
api_router.include_router(fan_requests.router, prefix="/fan-requests", tags=["fan-requests"])
api_router.include_router(fan_requests.admin_router, prefix="/admin", tags=["admin-fan-requests"])

# CS Ticket management (admin)
api_router.include_router(cs_api.router, prefix="", tags=["cs-tickets"])

# Internal EDA verification endpoints (non-production only)
api_router.include_router(eda_test.router, prefix="", tags=["eda-test"])

# P1-5: Behavior Tracking
api_router.include_router(tracking_api.router, prefix="", tags=["tracking"])

# P1-6: Web Push Notifications
api_router.include_router(push_api.router, prefix="/push", tags=["push"])
api_router.include_router(price_alerts_api.router, tags=["price-alerts"])
api_router.include_router(geofences_api.router, tags=["geofences"])
api_router.include_router(friendships_api.router, tags=["friends"])


# P1-4: Chatbot (2-Tier: FAQ + LLM)
api_router.include_router(chat_api.router, prefix="/chat", tags=["chatbot"])

# P1-7: Billing Key / One-click Payment
api_router.include_router(billing.router, prefix="/billing", tags=["billing"])

# P1-11: Conversion Funnel Analytics
api_router.include_router(funnel_api.router, prefix="/admin", tags=["funnel-analytics"])

# P1-12: Settlement Dashboard
api_router.include_router(admin_settlements.router, prefix="", tags=["admin-settlements"])

# P2-1: AI Agent Delegation Tokens
api_router.include_router(delegation.router, prefix="/delegation", tags=["delegation"])

# P2-2: Natural Language Event Search (Discover)
api_router.include_router(
    discover_api.router, prefix="/discover", tags=["discover"]
)

# P2-7: Multi-device continuity (session sync)
api_router.include_router(sync_api.router, prefix="", tags=["device-sync"])

# P2-15: Admin RBAC granular management
api_router.include_router(admin_roles.router, prefix="", tags=["admin-roles"])

# P2-3: Outbound Webhooks
api_router.include_router(
    outbound_webhooks.router, prefix="/webhooks", tags=["outbound-webhooks"]
)

# P2-14: Content Moderation
api_router.include_router(moderation_api.router, prefix="", tags=["moderation"])

# P2-4: Event Recommendations V2 (hybrid collaborative + content-based)
api_router.include_router(
    recommendations_api.router, prefix="/recommendations", tags=["recommendations"]
)

# P2-8: Post-event experience (memories, digital souvenirs, review prompts)
api_router.include_router(post_event.router, prefix="/events", tags=["post-event"])


# P2-11: Chargebacks (admin)
api_router.include_router(chargebacks_api.router, prefix="", tags=["chargebacks"])

# P2-12: Cohort Analysis (admin)
api_router.include_router(cohort_api.router, prefix="", tags=["cohort-analytics"])

# P2-13: AI Traffic Monitoring
api_router.include_router(traffic_monitor.router, prefix="", tags=["traffic-monitor"])

# Monitoring: SLO Dashboard (admin)
api_router.include_router(admin_slo.router, prefix="", tags=["admin-slo"])

# Ops: 운영 작업보드 (admin UI + 에이전트 서비스토큰 — OPS_ORCHESTRATION_PLAN §3)
api_router.include_router(ops_board.admin_router, prefix="/admin", tags=["ops-board"])
api_router.include_router(ops_board.internal_router, prefix="", tags=["ops-board-internal"])

# 레벨2 2차 D4: 사업자 인증 심사(go 흡수) — 내부(go 프록시)+admin(심사)
from app.api.v1 import business_verifications as _bizverif
api_router.include_router(
    _bizverif.internal_router, prefix="/internal", tags=["internal-business-verification"]
)
api_router.include_router(
    _bizverif.admin_router, prefix="/admin", tags=["admin-business-verification"]
)

# 레벨2 컷오버 T2-REST: go 전용 원장 흡수 — 세금계산서(규제) / 좌석 퍼널 텔레메트리
from app.api.v1 import internal_go_ledger as _internal_go_ledger
api_router.include_router(
    _internal_go_ledger.router, prefix="/internal", tags=["internal-go-ledger"]
)

# 레벨2 컷오버 W5-ATTENDEE: go 참석자 부속 원장 흡수 — 설문문항/초대권/발송큐/좌석찜/체크인
from app.api.v1 import internal_attendee_ledger as _internal_attendee_ledger
api_router.include_router(
    _internal_attendee_ledger.router, prefix="/internal", tags=["internal-attendee-ledger"]
)

# 레벨2 2차 D4: go 감사 로그 흡수 — 내부(HMAC) 수집
from app.api.v1 import internal_audit as _internal_audit
api_router.include_router(
    _internal_audit.router, prefix="/internal", tags=["internal-audit"]
)

# Internal: go → v2 data sync (HMAC-authenticated)
api_router.include_router(internal_sync.router, prefix="/internal", tags=["internal-sync"])
# 과업 WP1·WP4: 가중치 추첨 정책 · Merkle · 공정성 증명서
api_router.include_router(fairness_api.internal_router, prefix="/internal", tags=["internal-fairness"])
api_router.include_router(maps_api.internal_router, prefix="/internal", tags=["internal-maps"])
api_router.include_router(fairness_api.public_router, prefix="/fairness", tags=["fairness"])
# 과업 WP6·WP7: 현장 단말 · 주최사 PG 직결 · 연동 원장
api_router.include_router(onsite_api.terminal_router, prefix="/terminals", tags=["onsite-terminal"])
api_router.include_router(onsite_api.internal_router, prefix="/internal", tags=["internal-onsite"])
api_router.include_router(internal_commerce.router, prefix="/internal", tags=["internal-commerce"])
api_router.include_router(internal_commerce_read.router, prefix="/internal", tags=["internal-commerce-read"])
# 레벨2 컷오버 T1 — go 주최자 계정 화면(v2 organizer_profiles 정본)
api_router.include_router(internal_organizer_account.router, prefix="/internal", tags=["internal-organizer-account"])
api_router.include_router(internal_organizer_team.router, prefix="/internal", tags=["internal-organizer-team"])
api_router.include_router(internal_hosts.router, prefix="/internal", tags=["internal-hosts"])
# 레벨2 W5-CONTENT: 콘텐츠·표시 계열(위젯/티켓디자인/브릿지/공지/시설/출연진) go 흡수
api_router.include_router(internal_organizer_content.router, prefix="/internal", tags=["internal-organizer-content"])
api_router.include_router(internal_waitlist.router, prefix="/internal", tags=["internal-waitlist"])
api_router.include_router(internal_messaging.router, prefix="/internal", tags=["internal-messaging"])
api_router.include_router(internal_support.router, prefix="/internal", tags=["internal-support"])
api_router.include_router(queue.internal_router, prefix="/internal", tags=["internal-queue"])
api_router.include_router(
    outbound_webhooks.internal_router,
    prefix="/internal",
    tags=["internal-webhooks"],
)
