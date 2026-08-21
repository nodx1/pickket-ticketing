/**
 * Queue (대기열) type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface QueueJoinResponse {
  position: number;
  total_waiting: number;
  is_active: boolean;
  estimated_wait_seconds: number;
  token: string | null;
  message: string;
}

export interface QueueStatusResponse {
  position: number;
  total_waiting: number;
  is_active: boolean;
  estimated_wait_seconds: number;
  token: string | null;
}

export interface QueueLeaveResponse {
  success: boolean;
  message: string;
}

export interface QueueStatsResponse {
  total_waiting: number;
  active_count: number;
  max_active: number;
}
