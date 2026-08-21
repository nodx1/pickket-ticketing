/**
 * Review type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface ReviewData {
  id: string;
  user_id: string;
  event_id: string;
  rating: number;
  title: string;
  content: string;
  is_verified_attendee: boolean;
  helpful_count: number;
  reviewer_name: string;
  created_at: string;
}

export interface ReviewSummaryData {
  average_rating: number;
  total_reviews: number;
  rating_distribution: Record<number, number>;
}
