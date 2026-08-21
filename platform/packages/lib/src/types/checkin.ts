/**
 * Check-in type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface CheckInResponse {
  attendance_id: string;
  ticket_id: string;
  user_id: string;
  event_id: string;
  checked_in_at: string;
  method: string;
  deposit_refunded: boolean;
}

export interface AttendanceStats {
  event_id: string;
  total_tickets: number;
  checked_in: number;
  not_checked_in: number;
  attendance_rate: number;
  hourly_breakdown: { hour: string; count: number }[];
}
