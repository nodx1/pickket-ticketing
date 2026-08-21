/**
 * 좌석 도메인 배럴 — Phase 2 v2 포팅 + Phase 10~11.5
 */
export { seatRepo } from "./repo";
export { tierRepo } from "./tier-repo";
export type {
  BestAvailableQuery,
  Seat,
  SeatHoldRequest,
  SeatHoldResponse,
  SeatStatus,
  SeatTier,
} from "./types";
export { findAdjacentSeats, validateGroupRequest } from "./group-tickets";
export type { GroupRequest, GroupValidationResult } from "./group-tickets";
export {
  acquireSeatLock,
  acquireSeatLocks,
  releaseSeatLock,
  releaseSeatLocks,
} from "./hold-lock";
export type { SeatLockHandle } from "./hold-lock";
export {
  logSeatHold,
  logSeatRelease,
  logSeatSold,
  logSeatForceRelease,
} from "./audit";
export { notifySeatHoldExpiring, notifyCapacityFull } from "./notifications";
export { seatMetrics } from "./metrics";
export type { SeatMetricsSnapshot } from "./metrics";
export { isNewSeatSystemEnabled } from "./feature-flag";
