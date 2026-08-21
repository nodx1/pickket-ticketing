/**
 * WebSocket Manager for Pickket realtime features
 * - Auto-reconnect with exponential backoff
 * - Heartbeat (ping/pong)
 * - Room-based subscriptions (per event)
 * - Type-safe message handling
 */

export type WSChannel = "seats" | "event_stats" | "queue_position";

export interface WSMessage {
  type: string;
  event_id?: string;
  data?: Record<string, unknown>;
  message?: string;
}

export interface WSManagerOptions {
  url: string;
  onMessage?: (msg: WSMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number; // ms, default 30000
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolveWebSocketBaseUrl(explicitUrl?: string): string {
  const raw = explicitUrl?.trim();
  if (raw) {
    let normalized = trimTrailingSlash(raw);
    if (normalized.endsWith("/ws")) {
      normalized = normalized.slice(0, -3);
    }
    return normalized;
  }

  if (typeof window !== "undefined" && window.location.host) {
    return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  }

  return "ws://localhost:8031";
}

export function buildEventWebSocketUrl(
  eventId: string,
  explicitUrl?: string,
): string {
  return `${resolveWebSocketBaseUrl(explicitUrl)}/ws/${eventId}`;
}

export class WSManager {
  private ws: WebSocket | null = null;
  private url: string;
  private options: WSManagerOptions;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Set<string>(); // "channel:event_id"
  private intentionalClose = false;

  constructor(options: WSManagerOptions) {
    this.url = options.url;
    this.options = options;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.options.onConnect?.();
        // Re-subscribe to all previous subscriptions
        for (const sub of this.subscriptions) {
          const [channel, eventId] = sub.split(":");
          this.send({ type: "subscribe", channel, event_id: eventId });
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data as string);
          if (msg.type === "pong") return; // heartbeat response
          this.options.onMessage?.(msg);
        } catch {
          // ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.options.onDisconnect?.();
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  subscribe(channel: WSChannel, eventId: string): void {
    const key = `${channel}:${eventId}`;
    this.subscriptions.add(key);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "subscribe", channel, event_id: eventId });
    }
  }

  unsubscribe(channel: WSChannel, eventId: string): void {
    const key = `${channel}:${eventId}`;
    this.subscriptions.delete(key);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "unsubscribe", channel, event_id: eventId });
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatInterval ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "ping" });
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
