import type { PageStatus } from "./pages";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiEntry {
  method: HttpMethod;
  path: string;
  mod: string;
  fn: string;
  status: PageStatus;
}

/** 이 파일을 수동 업데이트할 때마다 날짜를 갱신하세요 */
export const APIS_LAST_UPDATED = "2026-04-03";

export const apis: ApiEntry[] = [
  // Auth
  {
    method: "POST",
    path: "/auth/register",
    mod: "auth",
    fn: "register",
    status: "done",
  },
  {
    method: "POST",
    path: "/auth/login",
    mod: "auth",
    fn: "login",
    status: "done",
  },
  {
    method: "POST",
    path: "/auth/refresh",
    mod: "auth",
    fn: "refresh_token",
    status: "done",
  },
  {
    method: "POST",
    path: "/auth/logout",
    mod: "auth",
    fn: "logout",
    status: "done",
  },
  {
    method: "GET",
    path: "/auth/oauth/{provider}/redirect",
    mod: "auth",
    fn: "oauth_redirect",
    status: "done",
  },
  {
    method: "POST",
    path: "/auth/oauth/{provider}/callback",
    mod: "auth",
    fn: "oauth_callback",
    status: "done",
  },
  {
    method: "POST",
    path: "/auth/password/reset-request",
    mod: "auth",
    fn: "request_password_reset",
    status: "done",
  },
  {
    method: "POST",
    path: "/auth/password/reset-confirm",
    mod: "auth",
    fn: "confirm_password_reset",
    status: "done",
  },

  // Users
  {
    method: "GET",
    path: "/users/me",
    mod: "users",
    fn: "get_current_user_profile",
    status: "done",
  },
  {
    method: "PATCH",
    path: "/users/me",
    mod: "users",
    fn: "update_current_user_profile",
    status: "done",
  },
  {
    method: "GET",
    path: "/users/me/tier",
    mod: "users",
    fn: "get_my_tier",
    status: "done",
  },
  {
    method: "GET",
    path: "/users/me/bids",
    mod: "users",
    fn: "get_bid_history",
    status: "done",
  },
  {
    method: "GET",
    path: "/users/me/stats",
    mod: "users",
    fn: "get_user_stats",
    status: "done",
  },
  {
    method: "GET",
    path: "/users/me/favorites",
    mod: "users",
    fn: "list_user_favorites",
    status: "done",
  },
  {
    method: "DELETE",
    path: "/users/me",
    mod: "users",
    fn: "request_account_deletion",
    status: "done",
  },
  {
    method: "GET",
    path: "/users/me/data-export",
    mod: "users",
    fn: "export_my_data",
    status: "done",
  },

  // Events
  {
    method: "GET",
    path: "/events/search",
    mod: "events",
    fn: "search_events",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/featured",
    mod: "events",
    fn: "featured_events",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/trending",
    mod: "events",
    fn: "trending_events",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/opening-soon",
    mod: "events",
    fn: "opening_soon_events",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/ranking",
    mod: "events",
    fn: "event_ranking",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/categories",
    mod: "events",
    fn: "event_categories",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/recommended",
    mod: "events",
    fn: "recommended_events",
    status: "done",
  },
  {
    method: "POST",
    path: "/events/",
    mod: "events",
    fn: "create_event",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/",
    mod: "events",
    fn: "list_events",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/{id}",
    mod: "events",
    fn: "get_event",
    status: "done",
  },
  {
    method: "PATCH",
    path: "/events/{id}",
    mod: "events",
    fn: "update_event",
    status: "done",
  },
  {
    method: "DELETE",
    path: "/events/{id}",
    mod: "events",
    fn: "delete_event",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/{id}/transparency",
    mod: "events",
    fn: "transparency_report",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/{id}/similar",
    mod: "events",
    fn: "similar_events",
    status: "done",
  },
  {
    method: "POST",
    path: "/events/{id}/view",
    mod: "events",
    fn: "record_view",
    status: "done",
  },
  {
    method: "POST",
    path: "/events/{id}/favorite",
    mod: "events",
    fn: "toggle_favorite",
    status: "done",
  },

  // Tiers
  {
    method: "GET",
    path: "/events/{id}/tiers",
    mod: "tiers",
    fn: "list_tiers",
    status: "done",
  },
  {
    method: "PATCH",
    path: "/events/{id}/tiers/{tier_id}",
    mod: "tiers",
    fn: "update_tier",
    status: "done",
  },

  // Seats
  {
    method: "GET",
    path: "/events/{id}/seats",
    mod: "seats",
    fn: "list_seats",
    status: "done",
  },
  {
    method: "DELETE",
    path: "/events/{id}/seats/hold",
    mod: "seats",
    fn: "release_seats",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/{id}/seats/best-available",
    mod: "seats",
    fn: "best_available_seats",
    status: "done",
  },

  // Venues
  {
    method: "GET",
    path: "/venues/",
    mod: "venues",
    fn: "list_venues",
    status: "done",
  },
  {
    method: "GET",
    path: "/venues/{id}",
    mod: "venues",
    fn: "get_venue",
    status: "done",
  },
  {
    method: "GET",
    path: "/venues/{id}/sections",
    mod: "venues",
    fn: "list_venue_sections",
    status: "done",
  },

  // Bids
  {
    method: "POST",
    path: "/events/{id}/bids",
    mod: "bids",
    fn: "create_bid",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/{id}/bids/status",
    mod: "bids",
    fn: "get_bid_status",
    status: "done",
  },
  {
    method: "PATCH",
    path: "/events/{id}/bids/{bid_id}",
    mod: "bids",
    fn: "update_bid",
    status: "done",
  },
  {
    method: "DELETE",
    path: "/events/{id}/bids/{bid_id}",
    mod: "bids",
    fn: "cancel_bid",
    status: "done",
  },

  // Allocations
  {
    method: "GET",
    path: "/events/{id}/results",
    mod: "allocations",
    fn: "get_allocation_results",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/{id}/my-result",
    mod: "allocations",
    fn: "get_my_result",
    status: "done",
  },

  // Orders
  {
    method: "GET",
    path: "/orders/my",
    mod: "orders",
    fn: "my_orders",
    status: "done",
  },
  {
    method: "GET",
    path: "/orders/{id}",
    mod: "orders",
    fn: "get_order",
    status: "done",
  },
  {
    method: "POST",
    path: "/orders/{id}/pay",
    mod: "orders",
    fn: "confirm_payment",
    status: "wip",
  },
  {
    method: "POST",
    path: "/orders/{id}/refund",
    mod: "orders",
    fn: "refund_order",
    status: "wip",
  },
  {
    method: "POST",
    path: "/orders/{id}/cancel",
    mod: "orders",
    fn: "cancel_order",
    status: "done",
  },
  {
    method: "POST",
    path: "/orders/webhooks/portone",
    mod: "orders",
    fn: "portone_webhook",
    status: "done",
  },

  // Tickets
  {
    method: "GET",
    path: "/tickets/my",
    mod: "tickets",
    fn: "my_tickets",
    status: "done",
  },
  {
    method: "GET",
    path: "/tickets/{id}",
    mod: "tickets",
    fn: "get_ticket",
    status: "done",
  },
  {
    method: "GET",
    path: "/tickets/{id}/qr",
    mod: "tickets",
    fn: "get_ticket_qr",
    status: "done",
  },

  // Points
  {
    method: "GET",
    path: "/points/balance",
    mod: "points",
    fn: "get_point_balance",
    status: "done",
  },
  {
    method: "GET",
    path: "/points/history",
    mod: "points",
    fn: "get_point_history",
    status: "done",
  },

  // Notifications
  {
    method: "GET",
    path: "/notifications/",
    mod: "notifications",
    fn: "get_notifications",
    status: "done",
  },
  {
    method: "GET",
    path: "/notifications/unread-count",
    mod: "notifications",
    fn: "unread_count",
    status: "done",
  },
  {
    method: "POST",
    path: "/notifications/{id}/read",
    mod: "notifications",
    fn: "mark_notification_read",
    status: "done",
  },
  {
    method: "GET",
    path: "/notifications/stream",
    mod: "notifications",
    fn: "notification_stream",
    status: "done",
  },

  // Resale
  {
    method: "GET",
    path: "/resale/events",
    mod: "resale",
    fn: "resale_events",
    status: "done",
  },
  {
    method: "GET",
    path: "/resale/stream/{event_id}/{tier_id}",
    mod: "resale",
    fn: "market_stream",
    status: "done",
  },
  {
    method: "GET",
    path: "/resale/fee-info",
    mod: "resale",
    fn: "get_fee_info",
    status: "done",
  },

  // Fanclubs
  {
    method: "GET",
    path: "/fanclubs/",
    mod: "fanclubs",
    fn: "list_fanclubs",
    status: "done",
  },
  {
    method: "GET",
    path: "/fanclubs/{id}",
    mod: "fanclubs",
    fn: "get_fanclub",
    status: "done",
  },
  {
    method: "POST",
    path: "/fanclubs/",
    mod: "fanclubs",
    fn: "create_fanclub",
    status: "done",
  },

  // Organizer
  {
    method: "GET",
    path: "/organizer/dashboard",
    mod: "organizer",
    fn: "get_organizer_dashboard",
    status: "done",
  },
  {
    method: "GET",
    path: "/organizer/events",
    mod: "organizer",
    fn: "list_organizer_events",
    status: "done",
  },
  {
    method: "GET",
    path: "/organizer/events/{id}/kpi",
    mod: "organizer",
    fn: "get_event_kpi",
    status: "done",
  },
  {
    method: "GET",
    path: "/organizer/events/{id}/analytics",
    mod: "organizer",
    fn: "get_event_analytics",
    status: "done",
  },
  {
    method: "GET",
    path: "/organizer/settlement",
    mod: "organizer",
    fn: "get_settlement_summary",
    status: "done",
  },

  // Admin
  {
    method: "GET",
    path: "/admin/kpi",
    mod: "admin",
    fn: "get_platform_kpi",
    status: "done",
  },
  {
    method: "GET",
    path: "/admin/users",
    mod: "admin",
    fn: "list_users",
    status: "done",
  },
  {
    method: "GET",
    path: "/admin/events",
    mod: "admin",
    fn: "list_events",
    status: "done",
  },
  {
    method: "POST",
    path: "/admin/events/{id}/feature",
    mod: "admin",
    fn: "toggle_event_featured",
    status: "done",
  },
  {
    method: "POST",
    path: "/admin/events/{id}/cancel",
    mod: "admin",
    fn: "admin_cancel_event",
    status: "done",
  },
  {
    method: "GET",
    path: "/admin/audit-logs",
    mod: "admin",
    fn: "get_audit_logs",
    status: "done",
  },
  {
    method: "GET",
    path: "/admin/finance/summary",
    mod: "admin",
    fn: "finance_summary",
    status: "done",
  },

  // Checkin
  {
    method: "POST",
    path: "/events/{id}/checkin",
    mod: "checkin",
    fn: "check_in",
    status: "done",
  },
  {
    method: "GET",
    path: "/events/{id}/checkin/stats",
    mod: "checkin",
    fn: "get_checkin_stats",
    status: "done",
  },

  // Health
  {
    method: "GET",
    path: "/health/live",
    mod: "health",
    fn: "live_health",
    status: "done",
  },
  {
    method: "GET",
    path: "/health/detailed",
    mod: "health",
    fn: "detailed_health",
    status: "done",
  },
];
