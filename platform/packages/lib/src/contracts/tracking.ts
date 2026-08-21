/**
 * AUDIT 2026-04-20 §40 P0: single source of truth for tracking events.
 */
export const TRACKING_EVENTS = [
  "page_view",
  "event_view",
  "search",
  "bid",
  "purchase",
  "share",
  "favorite",
  "click",
  "discover_card_view",
  "purchase_start",
  "purchase_complete",
  "payment_cancel",
  "app_open",
  "login_success",
  "signup_complete",
  "queue_joined",
  "waitlist_joined",
  "lottery_applied",
  "notification_opened",
  "ticket_check_in",
  "payment_error",
] as const;
export type TrackingEventType = (typeof TRACKING_EVENTS)[number];
