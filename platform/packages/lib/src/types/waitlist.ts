/**
 * Waitlist (정가 대기열) type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface WaitlistEntryResponse {
  id: string;
  tier_id: string;
  user_id: string;
  position: number;
  priority_score: number;
  status: "waiting" | "offered" | "accepted" | "expired" | "removed";
  entered_at: string;
}

export interface WaitlistStatusResponse {
  total_waiting: number;
  my_position: number | null;
  my_entry: WaitlistEntryResponse | null;
}
