/**
 * Ticket-related type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface TicketDetail {
  id: string;
  event_id: string;
  tier_id: string;
  tier_name?: string;
  seat_id: string | null;
  current_owner_id: string;
  purchase_price: number;
  sale_mode: string;
  status: string;
  is_resalable: boolean;
  transfer_count: number;
  created_at: string;
}

export interface TicketListResponse {
  tickets: TicketDetail[];
  total: number;
}

export interface TicketQrResponse {
  ticket_id: string;
  qr_data: string;
  expires_in_seconds: number;
  /** 화면이 새 QR 을 받아 올 주기(초). expires_in_seconds(입구에서 인정하는 시간)보다 짧다. 옛 서버는 안 보낸다. */
  refresh_in_seconds?: number | null;
}
