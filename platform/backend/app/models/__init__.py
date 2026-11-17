from app.models.user import User
from app.models.event import Event, SeatTier
from app.models.bid import Bid
from app.models.allocation import Allocation, AllocationResult
from app.models.interaction import UserInteraction
from app.models.seat import Seat
from app.models.seat_map_template import SeatMapTemplate
from app.models.ticket import Ticket
from app.models.order import Order
from app.models.order_item import OrderItem, OrderDiscount
from app.models.ownership_transfer import OwnershipTransfer
from app.models.phase_config import PhaseConfig
from app.models.lottery import LotteryPool, LotteryEntry
from app.models.waitlist import WaitlistEntryModel
from app.models.organizer_waitlist import OrganizerWaitlistEntry, OrganizerWaitlistStatus
from app.models.notification import NotificationModel, PriceAlertModel
from app.models.geofence import GeofenceSubscription
from app.models.friendship import Friendship, FriendshipStatus
from app.models.audit import AuditEntryModel
from app.models.session_history import SessionHistoryModel
from app.models.group import GroupModel, GroupMemberModel
from app.models.resale import ResaleListingModel, ResaleBuyOrderModel
from app.models.venue import Venue, VenueSection
from app.models.attendance import Attendance
from app.models.event_staff import EventStaffAssignment, EventStaffRole
from app.models.point import PointWallet, PointTransaction
from app.models.fanclub import (
    Fanclub,
    FanclubMembership,
    MembershipTier,
    MembershipStatus,
    Community,
    CommunityMembership,
)
from app.models.domain_config import DomainConfig
from app.models.organizer import OrganizerProfile, OrganizerStatus
from app.models.business_verification import (
    BusinessVerification,
    BusinessVerificationDocument,
    BizVerificationStatus,
    BizDocType,
)
from app.models.organizer_request import OrganizerRequest, RequestType, RequestStatus
from app.models.open_notice import OpenNotice, OpenNoticeStatus, OpenNoticeType
from app.models.participant import ParticipantSlot, ParticipantAssignment
from app.models.event_mirror import EventParticipant, EventAnnouncement, EventFacility

# 레벨2 W5-CONTENT — go 콘텐츠·표시 계열 정본(event_mirror 는 이들의 소비자 노출 투영)
from app.models.organizer_content import (
    OrganizerBridgePage,
    OrganizerEventFacility,
    OrganizerEventParticipant,
    OrganizerOpenNotice,
    OrganizerTicketDesign,
    OrganizerWidgetConfig,
)

# 레벨2 컷오버 T2-REST — go 전용 원장 흡수(세금계산서 원장 / 좌석 퍼널 텔레메트리).
from app.models.go_ledger import TaxInvoice, SeatFunnelEvent

# 레벨2 컷오버 W5-ATTENDEE — go 참석자 부속 원장 6종 흡수.
from app.models.go_attendee_ledger import (
    EventQuestion,
    EventInvitation,
    InvitationDispatch,
    SeatWatch,
    CheckInList,
    CheckInLog,
)
from app.models.discount import Discount, DiscountType
from app.models.final_call import FinalCall, FinalCallStatus
from app.models.promotion import Promotion, PromotionType, PromotionStatus
from app.models.bridge_page import BridgePage
from app.models.partnership import PartnershipRequest, PartnerType, PartnershipStatus
from app.models.package_product import PackageProduct, PackageItem, PackageStatus
from app.models.ticket_issuance import (
    TicketIssuanceRequest,
    IssuanceType,
    DeliveryMethod,
    IssuanceStatus,
)
from app.models.anomaly import AnomalyLogModel
from app.models.exchange_rate import ExchangeRate
from app.models.partner import Partner, PartnerOrder, PartnerOrderStatus
from app.models.reconciliation import (
    ReconciliationBatch,
    ReconciliationMismatch,
    ReconciliationStatus,
    MismatchType,
)
from app.models.review import Review
from app.models.newsletter import NewsletterSubscriber
from app.models.contact_inquiry import ContactInquiry
from app.models.public_intent import RsvpRegistration, GroupBookingRequest
from app.models.career_application import CareerApplication
from app.models.organizer_team import OrganizerTeamMember, TeamRole
from app.models.message import OrganizerMessage
from app.models.template_change import TemplateChangeRequest, TemplateChangeStatus
from app.models.pity import PityTracker
from app.models.shop import ShopItem, ShopExchange, ShopCategory, ShopExchangeStatus
from app.models.nft_ticket import NftTicket
from app.models.facility import PublicFacility
from app.models.proxy_booking import ProxyBooking
from app.models.image_asset import ImageAsset

# WP14: Gamification — Quest, Badge, Attendance
from app.models.quest import Quest, QuestCompletion, QuestType
from app.models.badge import Badge, UserBadge
from app.models.attendance_record import AttendanceRecord, AttendanceStreak

# WP18: Genre Supporter
from app.models.genre_supporter import GenreSupporter

# Phase C: Data Protection & Legal Compliance
from app.models.consent import UserConsent, ConsentPurpose
from app.models.audit_log import AuditLog
from app.models.refund import Refund, RefundItem, RefundStatus, RefundType
from app.models.fee_schedule import FeeSchedule
from app.models.settlement import OrganizerSettlement, SettlementStatus, SettlementAdjustment, SettlementType
from app.models.survey import SurveyResponse

# Follow system (discovery feed prerequisite)
from app.models.follow import Follow

# Subdomain event pages (1:1 with Event, separated to avoid model bloat)
from app.models.event_page import EventPage
from app.models.event_comment import EventComment, EventCommentLike

# Artist messages (Weverse-style organizer/artist → fan messages)
from app.models.artist_message import ArtistMessage

# Anticipation sessions (같이 기대하기)
from app.models.anticipation_session import AnticipationSession

# Digital photocard (shareable booking confirmation card)
from app.models.digital_photocard import DigitalPhotocard

# Fan letters
from app.models.fan_letter import FanLetter

# Fan requests
from app.models.fan_request_artist import FanRequestArtist
from app.models.fan_request import FanRequest

# Custom domain mapping
from app.models.custom_domain import CustomDomain, DomainStatus

# A/B testing
from app.models.ab_test import ABTest, ABTestAssignment, ABTestEvent, ABTestStatus

# CS Tickets
from app.models.cs_ticket import CSTicket, CSTicketComment, TicketCategory, TicketStatus, TicketPriority

# P1-5: Behavior Tracking
from app.models.user_behavior import UserBehavior

# P1-6: Web Push Subscriptions
from app.models.push_subscription import PushSubscription

# P1-9: Discount Codes
from app.models.discount_code import DiscountCode, DiscountCodeType
from app.models.affiliate import Affiliate, AffiliateConversion

# 레벨2 W5-COMMERCE: go 상거래 부가기능 흡수(단체예약·환불정책·동적가격·가격이력)
from app.models.commerce_extras import (
    GROUP_BOOKING_STATUSES,
    PRICING_RULE_TYPES,
    EventRefundPolicy,
    GroupBooking,
    TierPriceHistory,
    TierPricingRule,
)

# P1-7: Billing Key (saved card / one-click payment)
from app.models.billing_key import BillingKey

# M-2: 청구 시도 원장 (원클릭 결제 이중 청구 방어)
from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
from app.models.payment_manual_review import (
    ManualReviewKind,
    ManualReviewStatus,
    PaymentManualReview,
)

# P2-1: AI Agent Delegation Token
from app.models.delegation_token import DelegationToken

# P2-3: Outbound Webhooks
from app.models.webhook_subscription import WebhookSubscription, WebhookDelivery, DeliveryStatus
# PR-U5: Inter-service webhook audit (v2↔go/portone, X-Pickket-* standard)
from app.models.inter_service_webhook import InterServiceWebhookDelivery

# P2-14: Content Moderation
from app.models.moderation import ModerationQueue, ModerationContentType, ModerationStatus

# P2-8: Post-event memories / digital souvenirs
from app.models.event_memory import EventMemory, MemoryType

# P2-11: Chargebacks
from app.models.chargeback import Chargeback, ChargebackStatus

# P2-12: Analytics Aggregates & Cohort
from app.models.analytics_aggregate import DailyAggregate, CohortMetric

# Security: Password History
from app.models.password_history import PasswordHistory
from app.models.user_preference import UserPreference

# S-2(#26): Refresh token family persistent backup (Redis 단일 장애점 완화)
from app.models.refresh_token_family import RefreshTokenFamily

# 단계6: 활성 기능(P6 Laylo)이나 metadata 미등록 → autogen drop 오탐 발생하던 모델 등록 복구
from app.models.event_open_subscription import EventOpenSubscription
from app.models.ops_task import OpsTask, OpsTaskComment

# F1: 다일 입장 원장 (multi-day admission)
from app.models.event_admission import EventAdmission

# F4: 경품번호 시퀀스 카운터 + 추첨 실행 원장 (raffle number + draw)
from app.models.raffle import EventRaffleCounter, RaffleDraw

# 상세통합 S1: 게스트(비회원) 도메인 — 게스트 엔티티 + IDOR 방어 단회용 토큰
from app.models.guest import Guest, GuestAccessToken, GUEST_TOKEN_PURPOSES

# 레벨2 영역C: 조직자 메시징 서브시스템(go 흡수). 팬용 notification.py 와 별개.
from app.models.organizer_messaging import (
    OrganizerNotification,
    EventMessage,
    MessageDelivery,
    MessageDeliveryAttempt,
    MessageDeliveryOperatorAction,
    MessageConsent,
    MessageConsentEvent,
    MessageSuppression,
    ReminderSend,
    OrganizerWebhook,
    OrganizerWebhookLog,
    # W5-MSG: 발송 원장 계열 마무리 흡수(캠페인·수신함).
    EmailCampaign,
    EmailCampaignRecipient,
    InboundEmail,
)

# 레벨2 W2-EVT: go organizers / event_organizers 흡수(주최자 표기 엔티티 + 이벤트 연결)
from app.models.event_host import (
    EventHost,
    EventHostLink,
    EVENT_HOST_ROLES,
    EVENT_HOST_ROLE_ORDER,
)

# 레벨2 W5-SUPPORT: go event_reviews/event_inquiries/capacity_assignments/final_call_rules 흡수.
# ⚠️ EventPublicationReview 는 v2 Review(관람객 후기)와 **다른 개념**이다(게시 심사 원장).
from app.models.organizer_support import (
    CapacityAssignment,
    EventInquiry,
    EventPublicationReview,
    FinalCallRule,
)

# 과업 WP1·WP4: 가중치 정책 · Merkle 무결성 · 공정성 증명서
from app.models.fairness import (
    FairnessCertificate,
    LotteryMerkleLeaf,
    LotteryMerkleRoot,
    LotteryPoolPolicy,
    LotteryWeightPolicyRecord,
)
from app.models.sanction import AccountSanction  # 과업 WP2
from app.models.onsite import AdmissionBlock, OnsiteTerminal  # 과업 WP6
from app.models.direct_settlement import EventSettlementMode, OrganizerPgAccount, PlatformFeeInvoice  # 과업 WP7

__all__ = [
    "User",
    "Event",
    "SeatTier",
    "Bid",
    "Allocation",
    "AllocationResult",
    "UserInteraction",
    "Seat",
    "SeatMapTemplate",
    "Ticket",
    "Order",
    "OrderItem",
    "OrderDiscount",
    "OwnershipTransfer",
    "PhaseConfig",
    "LotteryPool",
    "LotteryEntry",
    "WaitlistEntryModel",
    "OrganizerWaitlistEntry",
    "OrganizerWaitlistStatus",
    "NotificationModel",
    "PriceAlertModel",
    "AuditEntryModel",
    "SessionHistoryModel",
    "GroupModel",
    "GroupMemberModel",
    "ResaleListingModel",
    "ResaleBuyOrderModel",
    "Venue",
    "VenueSection",
    "Attendance",
    "EventStaffAssignment",
    "EventStaffRole",
    "PointWallet",
    "PointTransaction",
    "Fanclub",
    "FanclubMembership",
    "MembershipTier",
    "MembershipStatus",
    "Community",
    "CommunityMembership",
    "DomainConfig",
    # Organizer portal models
    "OrganizerProfile",
    "OrganizerStatus",
    "OrganizerRequest",
    "RequestType",
    "RequestStatus",
    "OpenNotice",
    "OpenNoticeStatus",
    "OpenNoticeType",
    "ParticipantSlot",
    "ParticipantAssignment",
    "EventParticipant",
    "EventAnnouncement",
    "EventFacility",
    # 레벨2 컷오버 T2-REST (go 원장 흡수)
    "TaxInvoice",
    "SeatFunnelEvent",
    # 레벨2 컷오버 W5-ATTENDEE (go 참석자 부속 원장 흡수)
    "EventQuestion",
    "EventInvitation",
    "InvitationDispatch",
    "SeatWatch",
    "CheckInList",
    "CheckInLog",
    "Discount",
    "DiscountType",
    "FinalCall",
    "FinalCallStatus",
    "Promotion",
    "PromotionType",
    "PromotionStatus",
    "BridgePage",
    "PartnershipRequest",
    "PartnerType",
    "PartnershipStatus",
    "PackageProduct",
    "PackageItem",
    "PackageStatus",
    "TicketIssuanceRequest",
    "IssuanceType",
    "DeliveryMethod",
    "IssuanceStatus",
    "AnomalyLogModel",
    "ExchangeRate",
    "Partner",
    "PartnerOrder",
    "PartnerOrderStatus",
    "ReconciliationBatch",
    "ReconciliationMismatch",
    "ReconciliationStatus",
    "MismatchType",
    "Review",
    "NewsletterSubscriber",
    "ContactInquiry",
    "RsvpRegistration",
    "GroupBookingRequest",
    "CareerApplication",
    "OrganizerTeamMember",
    "TeamRole",
    "OrganizerMessage",
    "TemplateChangeRequest",
    "TemplateChangeStatus",
    # WP08: Pity System
    "PityTracker",
    # WP09: AP Shop
    "ShopItem",
    "ShopExchange",
    "ShopCategory",
    "ShopExchangeStatus",
    "NftTicket",
    "PublicFacility",
    "ProxyBooking",
    "ImageAsset",
    # WP14: Gamification
    "Quest",
    "QuestCompletion",
    "QuestType",
    "Badge",
    "UserBadge",
    "AttendanceRecord",
    "AttendanceStreak",
    # WP18: Genre Supporter
    "GenreSupporter",
    # Phase C: Data Protection & Legal Compliance
    "UserConsent",
    "ConsentPurpose",
    "AuditLog",
    # Refund
    "Refund",
    "RefundItem",
    "RefundStatus",
    "RefundType",
    # Fee & Settlement
    "FeeSchedule",
    "OrganizerSettlement",
    "SettlementStatus",
    "SettlementType",
    "SettlementAdjustment",
    # Survey
    "SurveyResponse",
    # Follow
    "Follow",
    # Event Pages
    "EventPage",
    # Artist Messages
    "ArtistMessage",
    # Anticipation Sessions
    "AnticipationSession",
    # Digital Photocard
    "DigitalPhotocard",
    # Fan Letters
    "FanLetter",
    # Fan Requests
    "FanRequestArtist",
    "FanRequest",
    # Custom Domain Mapping
    "CustomDomain",
    "DomainStatus",
    # A/B Testing
    "ABTest",
    "ABTestAssignment",
    "ABTestEvent",
    "ABTestStatus",
    # CS Tickets
    "CSTicket",
    "CSTicketComment",
    "TicketCategory",
    "TicketStatus",
    "TicketPriority",
    # P1-5: Behavior Tracking
    "UserBehavior",
    # P1-6: Web Push
    "PushSubscription",
    # P1-9: Discount Codes
    "DiscountCode",
    "Affiliate",
    "AffiliateConversion",
    "DiscountCodeType",
    # P1-7: Billing Key
    "BillingKey",
    # M-2: 청구 시도 원장 (이중 청구 방어)
    "PaymentAttempt",
    "PaymentAttemptStatus",
    # P2-1: Delegation Token
    "DelegationToken",
    # P2-3: Outbound Webhooks
    "WebhookSubscription",
    "WebhookDelivery",
    "InterServiceWebhookDelivery",
    "DeliveryStatus",
    # P2-14: Content Moderation
    "ModerationQueue",
    "ModerationContentType",
    "ModerationStatus",
    # P2-8: Post-event memories
    "EventMemory",
    "MemoryType",
    # P2-11: Chargebacks
    "Chargeback",
    "ChargebackStatus",
    # P2-12: Analytics Aggregates & Cohort
    "DailyAggregate",
    "CohortMetric",
    # Security: Password History
    "PasswordHistory",
    # P6: Event Open Subscription (Laylo DNA)
    "EventOpenSubscription",
    # S-2(#26): Refresh token family persistent backup
    "RefreshTokenFamily",
    # Ops: 운영 작업보드 (사람·AI 공용)
    "OpsTask",
    "OpsTaskComment",
    # F1: 다일 입장 원장
    "EventAdmission",
    # F4: 경품번호 + 추첨
    "EventRaffleCounter",
    "RaffleDraw",
    # 상세통합 S1: 게스트 도메인
    "Guest",
    "GuestAccessToken",
    "GUEST_TOKEN_PURPOSES",
    # 레벨2 영역C: 조직자 메시징 서브시스템 (go 흡수)
    "OrganizerNotification",
    "EventMessage",
    "MessageDelivery",
    "MessageDeliveryAttempt",
    "MessageDeliveryOperatorAction",
    "MessageConsent",
    "MessageConsentEvent",
    "MessageSuppression",
    "ReminderSend",
    "OrganizerWebhook",
    "OrganizerWebhookLog",
    "EmailCampaign",
    "EmailCampaignRecipient",
    "InboundEmail",
    # 레벨2 2차 D4: 사업자 인증 심사(go 흡수·상태머신+문서)
    "BusinessVerification",
    "BusinessVerificationDocument",
    "BizVerificationStatus",
    "BizDocType",
    # 레벨2 W2-EVT: 주최자 표기 엔티티(go organizers / event_organizers 흡수)
    "EventHost",
    "EventHostLink",
    "EVENT_HOST_ROLES",
    "EVENT_HOST_ROLE_ORDER",
    # 레벨2 W5-CONTENT: 콘텐츠·표시 계열 정본
    "OrganizerEventParticipant",
    "OrganizerOpenNotice",
    "OrganizerEventFacility",
    "OrganizerWidgetConfig",
    "OrganizerTicketDesign",
    "OrganizerBridgePage",
    # 레벨2 W5-COMMERCE: 상거래 부가기능(go group_bookings/refund_policies/pricing_rules/price_history 흡수)
    "GroupBooking",
    "EventRefundPolicy",
    "TierPricingRule",
    "TierPriceHistory",
    "GROUP_BOOKING_STATUSES",
    "PRICING_RULE_TYPES",
]
