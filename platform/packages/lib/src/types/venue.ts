/**
 * Venue & seat map type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface VenueData {
  id: string;
  name: string;
  city: string;
  address: string;
  total_capacity: number;
  map_svg_url: string | null;
  map_width: number;
  map_height: number;
  thumbnail_url: string | null;
  seating_chart_url?: string | null;
  sections: VenueSectionData[];
}

export interface VenueSectionData {
  id: string;
  venue_id: string;
  name: string;
  label: string;
  capacity: number;
  svg_path: string | null;
  center_x: number;
  center_y: number;
  floor: number;
  color: string;
  view_image_url?: string | null;
}

export interface SeatData {
  id: string;
  section: string;
  row_number: number;
  seat_number: number;
  is_obstructed: boolean;
  x: number;
  y: number;
  label: string | null;
  status: "available" | "held" | "sold" | "reserved";
  tier_id: string;
  quality_score: number;
}

export interface SeatHoldResult {
  success: boolean;
  held_seat_ids: string[];
  hold_until: string;
  hold_id: string;
}

export interface SessionData {
  event_id: string;
  session_number: number;
  event_date: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  status: string;
  title: string;
  venue: string;
  location_city: string | null;
  total_seats: number;
  available_seats: number;
}
