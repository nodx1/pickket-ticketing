/**
 * Point/AP-related type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface PointBalance {
  fan: number;
  social: number;
}

export interface PointTransaction {
  id: string;
  tx_type: string;
  amount: number;
  balance_after: number;
  reference_id: string | null;
  description: string | null;
  created_at: string;
}

export interface PointHistoryResponse {
  transactions: PointTransaction[];
  total: number;
}
