/**
 * Notification type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface AdminNotificationHistoryItem {
  id: string;
  sender_id: string;
  target: string;
  title: string;
  message: string;
  recipient_count: number;
  created_at: string;
}
