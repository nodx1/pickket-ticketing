/**
 * React Query 키 중앙 관리
 *
 * §2 P2: 모든 query key 를 한 곳에서 관리하여 오타·불일치 방지.
 * 훅에서 직접 문자열 배열을 쓰지 않고 이 상수를 import 한다.
 */

export const queryKeys = {
  // ── Events ──
  events: {
    all: ["events"] as const,
    detail: (eventId: string) => ["events", eventId, "detail"] as const,
    similar: (eventId: string) => ["events", eventId, "similar"] as const,
    tiers: (eventId: string) => ["events", eventId, "tiers"] as const,
    search: (params: object) => ["events", "search", params] as const,
    trending: (limit: number) => ["events", "trending", limit] as const,
    featured: () => ["events", "featured"] as const,
  },

  // ── Tickets ──
  tickets: {
    all: ["tickets"] as const,
    my: (skip?: number, limit?: number) => ["tickets", "my", skip, limit] as const,
    detail: (ticketId: string) => ["tickets", ticketId] as const,
    qr: (ticketId: string) => ["tickets", ticketId, "qr"] as const,
  },

  // ── Orders ──
  orders: {
    all: ["orders"] as const,
    my: (params?: Record<string, unknown>) => ["orders", "my", params] as const,
    detail: (orderId: string) => ["orders", orderId] as const,
  },

  // ── Notifications ──
  notifications: {
    all: ["notifications"] as const,
    list: (params?: Record<string, unknown>) => ["notifications", params] as const,
    unreadCount: () => ["notifications", "unread-count"] as const,
    preferences: () => ["notifications", "preferences"] as const,
  },

  // ── Points ──
  points: {
    balance: () => ["points", "balance"] as const,
    history: (limit: number, offset: number) => ["points", "history", limit, offset] as const,
  },

  // ── Picks ──
  picks: {
    all: ["picks"] as const,
  },

  // ── Favorites ──
  favorites: {
    all: ["favorites"] as const,
  },

  // ── Friends ──
  friends: {
    list: ["friends", "list"] as const,
    search: (query: string) => ["users", "search", query] as const,
  },

  // ── Fan ──
  fan: {
    profile: () => ["fan-profile"] as const,
    clubs: () => ["fanclubs", "my"] as const,
  },

  // ── Reviews ──
  reviews: {
    all: (eventId: string) => ["reviews", eventId] as const,
    summary: (eventId: string) => ["reviews", eventId, "summary"] as const,
    list: (eventId: string, skip?: number, limit?: number) =>
      ["reviews", eventId, skip, limit] as const,
  },

  // ── Price Alerts ──
  priceAlerts: {
    all: ["price-alerts"] as const,
    list: (params?: { includeTriggered?: boolean }) => ["price-alerts", params] as const,
  },

  // ── Queue ──
  queue: {
    status: (eventId: string) => ["queue", eventId, "status"] as const,
    stats: (eventId: string) => ["queue", eventId, "stats"] as const,
  },

  // ── Waitlist ──
  waitlist: {
    status: (eventId: string, tierId: string) =>
      ["waitlist", eventId, tierId, "status"] as const,
    detail: (eventId: string, tierId: string) =>
      ["waitlist", eventId, tierId] as const,
  },

  // ── Lottery ──
  lottery: {
    status: (eventId: string, tierId: string) =>
      ["lottery", eventId, tierId, "status"] as const,
    detail: (eventId: string, tierId: string) =>
      ["lottery", eventId, tierId] as const,
    result: (poolId: string) => ["lottery", "result", poolId] as const,
  },

  // ── Group Booking ──
  groupOrder: {
    detail: (groupId: string) => ["group-order", groupId] as const,
  },

  // ── Discover ──
  discover: {
    feed: (limit: number, category?: string) =>
      ["discover", "feed", limit, category] as const,
    search: (query: string) => ["discover", query] as const,
  },

  // ── Recommendations ──
  recommendations: {
    list: (limit: number) => ["recommendations", limit] as const,
  },

  // ── Schedule ──
  schedule: {
    today: () => ["schedule", "today"] as const,
    feed: (filter?: string) => ["schedule", "feed", filter] as const,
  },

  // ── My Event Status ──
  myEventStatus: (eventId: string) => ["myEventStatus", eventId] as const,
  myResult: (eventId: string) => ["myResult", eventId] as const,
} as const;
