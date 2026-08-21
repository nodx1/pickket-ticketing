/**
 * P3-12: Pickket Developer SDK
 *
 * Provides a typed client for the Pickket API.
 * Used by external developers building agent integrations.
 *
 * @example
 * ```ts
 * const pickket = new PickketSDK({ apiKey: 'pk_...' });
 * const events = await pickket.events.search('콘서트');
 * const details = await pickket.events.get(eventId);
 * const bid = await pickket.bids.place({ eventId, tierId, maxPrice: 50000 });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SDKConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  sandbox?: boolean;
  onError?: (error: SDKError) => void;
}

export interface SDKError {
  code: string;
  message: string;
  status?: number;
  details?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

export interface EventSummary {
  id: string;
  title: string;
  category: string;
  start_date: string | null;
  end_date: string | null;
  venue_name: string;
  image_url: string;
  status: string;
}

export interface EventDetail extends EventSummary {
  description: string;
  venue_address: string;
  tiers: TierInfo[];
  organizer_name: string;
}

export interface TierInfo {
  id: string;
  name: string;
  price: number;
  currency: string;
  total: number;
  available: number;
}

export interface BidResult {
  bid_id: string;
  event_id: string;
  tier_id: string;
  max_price: number;
  quantity: number;
  status: string;
}

export interface OrderResult {
  order_id: string;
  event_id: string;
  tier_id: string;
  quantity: number;
  total_amount: number;
  status: string;
  payment_url?: string;
}

export interface TicketInfo {
  ticket_id: string;
  event_id: string;
  event_title: string;
  tier_name: string;
  status: string;
  qr_code?: string;
}

export interface Recommendation {
  id: string;
  title: string;
  category: string;
  start_date: string | null;
  score: number;
  reason: string;
}

// ── SDK Client ───────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.pickket.kr/api/v1";
const SANDBOX_BASE_URL = "https://sandbox.api.pickket.kr/api/v1";

export class PickketSDK {
  private config: Required<Omit<SDKConfig, "onError">> &
    Pick<SDKConfig, "onError">;

  readonly events: EventsResource;
  readonly bids: BidsResource;
  readonly orders: OrdersResource;
  readonly tickets: TicketsResource;
  readonly recommendations: RecommendationsResource;

  constructor(config: SDKConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl:
        config.baseUrl ||
        (config.sandbox ? SANDBOX_BASE_URL : DEFAULT_BASE_URL),
      timeout: config.timeout || 10000,
      sandbox: config.sandbox || false,
      onError: config.onError,
    };

    this.events = new EventsResource(this);
    this.bids = new BidsResource(this);
    this.orders = new OrdersResource(this);
    this.tickets = new TicketsResource(this);
    this.recommendations = new RecommendationsResource(this);
  }

  get isSandbox(): boolean {
    return this.config.sandbox;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      params?: Record<string, string | number>;
      body?: unknown;
    },
  ): Promise<T> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      "X-SDK-Version": "1.0.0",
      "X-Agent-Name": "pickket-sdk",
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const error: SDKError = {
          code: errorBody.code || `HTTP_${response.status}`,
          message: errorBody.detail || errorBody.message || response.statusText,
          status: response.status,
          details: errorBody,
        };
        this.config.onError?.(error);
        throw error;
      }

      return (await response.json()) as T;
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as any).code) throw err; // Already an SDKError

      const error: SDKError = {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : "Unknown error",
      };
      this.config.onError?.(error);
      throw error;
    }
  }
}

// ── Resource Classes ─────────────────────────────────────────────────────────

class EventsResource {
  constructor(private sdk: PickketSDK) {}

  async search(
    query: string,
    options?: { category?: string; limit?: number; page?: number },
  ): Promise<PaginatedResponse<EventSummary>> {
    return this.sdk.request("GET", "/discover/search", {
      params: {
        q: query,
        ...(options?.category && { category: options.category }),
        limit: options?.limit || 10,
        page: options?.page || 1,
      },
    });
  }

  async get(eventId: string): Promise<EventDetail> {
    return this.sdk.request("GET", `/public-events/${eventId}`);
  }

  async checkAvailability(
    eventId: string,
    tierId?: string,
  ): Promise<{ tiers: TierInfo[] }> {
    const params: Record<string, string> = {};
    if (tierId) params.tier_id = tierId;
    return this.sdk.request("GET", `/events/${eventId}/tiers`, { params });
  }

  async list(options?: {
    category?: string;
    limit?: number;
    page?: number;
  }): Promise<PaginatedResponse<EventSummary>> {
    return this.sdk.request("GET", "/public-events", {
      params: {
        ...(options?.category && { category: options.category }),
        limit: options?.limit || 20,
        page: options?.page || 1,
      },
    });
  }
}

class BidsResource {
  constructor(private sdk: PickketSDK) {}

  async place(params: {
    eventId: string;
    tierId: string;
    maxPrice: number;
    quantity?: number;
  }): Promise<BidResult> {
    return this.sdk.request("POST", `/events/${params.eventId}/bids`, {
      body: {
        tier_id: params.tierId,
        max_price: params.maxPrice,
        quantity: params.quantity || 1,
      },
    });
  }

  async list(eventId: string): Promise<PaginatedResponse<BidResult>> {
    return this.sdk.request("GET", `/events/${eventId}/bids`);
  }

  async cancel(eventId: string, bidId: string): Promise<{ success: boolean }> {
    return this.sdk.request("DELETE", `/events/${eventId}/bids/${bidId}`);
  }
}

class OrdersResource {
  constructor(private sdk: PickketSDK) {}

  async create(params: {
    eventId: string;
    tierId: string;
    quantity?: number;
  }): Promise<OrderResult> {
    return this.sdk.request("POST", `/events/${params.eventId}/purchase`, {
      body: {
        tier_id: params.tierId,
        quantity: params.quantity || 1,
      },
    });
  }

  async get(orderId: string): Promise<OrderResult> {
    return this.sdk.request("GET", `/orders/${orderId}`);
  }

  async list(options?: {
    status?: string;
    limit?: number;
  }): Promise<PaginatedResponse<OrderResult>> {
    return this.sdk.request("GET", "/orders", {
      params: {
        ...(options?.status && { status: options.status }),
        limit: options?.limit || 20,
      },
    });
  }

  async cancel(
    orderId: string,
    reason?: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.sdk.request("POST", `/orders/${orderId}/cancel`, {
      body: { reason: reason || "SDK cancel request" },
    });
  }
}

class TicketsResource {
  constructor(private sdk: PickketSDK) {}

  async list(options?: {
    status?: string;
    limit?: number;
  }): Promise<PaginatedResponse<TicketInfo>> {
    return this.sdk.request("GET", "/tickets", {
      params: {
        ...(options?.status && { status: options.status }),
        limit: options?.limit || 20,
      },
    });
  }

  async get(ticketId: string): Promise<TicketInfo> {
    return this.sdk.request("GET", `/tickets/${ticketId}`);
  }

  async transfer(
    ticketId: string,
    recipientEmail: string,
  ): Promise<{ success: boolean; transfer_id: string }> {
    return this.sdk.request("POST", `/transfers`, {
      body: { ticket_id: ticketId, recipient_email: recipientEmail },
    });
  }
}

class RecommendationsResource {
  constructor(private sdk: PickketSDK) {}

  async get(limit?: number): Promise<Recommendation[]> {
    return this.sdk.request("GET", "/recommendations", {
      params: { limit: limit || 5 },
    });
  }
}

export default PickketSDK;
