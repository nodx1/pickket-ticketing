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
}
