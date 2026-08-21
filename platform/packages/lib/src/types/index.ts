/**
 * Pickket v2 shared type definitions.
 * Re-exports all mobile-facing types from individual modules.
 *
 * Usage (from mobile app or any consumer):
 *   import type { Event, TicketDetail } from "@pickket/lib/types";
 */

export type {
  ProgramPiece,
  EventProgramData,
  SeatTierCompact,
  Event,
  EventDetail,
  SearchParams,
  CategoryCount,
  PriceAdvice,
  RankingEvent,
  MyEventStatus,
  SeatTier,
  PurchaseResult,
} from "./event";

export type { OrderDetail, PaymentPrepareResponse } from "./order";

export type {
  TicketDetail,
  TicketListResponse,
  TicketQrResponse,
} from "./ticket";

export type {
  PointBalance,
  PointTransaction,
  PointHistoryResponse,
} from "./point";

export type {
  OrderBookLevel,
  TradeRecord,
  MarketSummary,
  PriceCandle,
  TradingData,
  MyResaleListing,
  MyResaleBuyOrder,
  ResaleListingDetail,
  ResaleListingBrowseResponse,
  ResaleTierInfo,
} from "./resale";

export type { AdminNotificationHistoryItem } from "./notification";

export type {
  QueueJoinResponse,
  QueueStatusResponse,
  QueueLeaveResponse,
  QueueStatsResponse,
} from "./queue";

export type { WaitlistEntryResponse, WaitlistStatusResponse } from "./waitlist";

export type { ReviewData, ReviewSummaryData } from "./review";

export type { CheckInResponse, AttendanceStats } from "./checkin";

export type {
  VenueData,
  VenueSectionData,
  SeatData,
  SeatHoldResult,
  SessionData,
} from "./venue";
