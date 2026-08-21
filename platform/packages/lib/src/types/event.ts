/**
 * Event-related type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface ProgramPiece {
  composer: string;
  title: string;
  movements?: string[];
  duration_min?: number;
  soloist?: string;
}

export type EventProgramData = ProgramPiece[] | Record<string, unknown> | null;

/**
 * Matches backend SeatTierResponseCompact schema (embedded in EventResponse).
 */
export interface SeatTierCompact {
  id: string;
  name: string;
  capacity: number;
  base_price: number;
  sale_mode: string;
  face_price: number;
  sold_count: number;
  min_price: number;
  max_price_cap: number;
  lottery_application_hours: number;
  seating_type: string;
  bidding_opens_at: string | null;
  bidding_closes_at: string | null;
}

export interface Event {
  id: string;
  title: string;
  slug?: string;
  description?: string;
  venue: string;
  event_date: string;
  total_seats: number;
  min_price: number;
  max_price: number | null;
  status: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  category: string;
  sub_category?: string;
  image_url?: string;
  images?: string[];
  thumbnail_url?: string;
  location_city?: string;
  artist_name?: string;
  subject_name?: string | null;
  age_restriction?: string;
  tags?: string;
  is_featured: boolean;
  bid_count: number;
  view_count: number;
  is_public_sector?: boolean;
  is_free?: boolean;
  deposit_amount?: number;
  // Backend: list[dict] | dict | None — kept in sync with api.ts Event type.
  discount_policies?:
    | Record<string, number>
    | Array<Record<string, unknown>>
    | null;
  resident_priority?: boolean;
  resident_priority_days?: number;
  nft_enabled?: boolean;
  duration_minutes?: number;
  event_date_end?: string;
  participant_enabled?: boolean;
  // Global / i18n fields
  currency?: string;
  event_timezone?: string;
  // Sports-specific fields
  home_team?: string;
  away_team?: string;
  match_status?: string;
  broadcast_url?: string;
  broadcast_platform?: string;
  parking_info?: string;
  // Classical / Festival fields
  program_notes?: string;
  program_data?: EventProgramData;
  stage_info?: string;
  time_slot_enabled?: boolean;
  time_slot_capacity?: number | null;
  time_slot_duration_minutes?: number | null;
  blurhash?: string | null;
  image_variants?: Record<string, string> | null;
  comment_count?: number;
  // 재고 소진 여부 (backend EventResponse.is_sold_out — 좌석합/판매합 집계 파생)
  is_sold_out?: boolean;
  sale_mode?: string;
  // Derived from dominant seat tier (backend EventResponse.primary_sale_mode)
  primary_sale_mode?: string | null;
  // DICE+Laylo DNA (A1, A4)
  service_fee_rate?: number;
  brand_color?: string | null;
  brand_color_fg?: string | null;
}

/**
 * Matches backend EventResponse schema (detail endpoint).
 */
export interface EventDetail {
  id: string;
  organizer_id: string;
  title: string;
  slug?: string;
  description: string | null;
  venue: string;
  venue_id?: string | null;
  event_date: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  total_seats: number;
  min_price: number;
  max_price: number | null;
  status: string;
  created_at?: string;
  // Extended fields
  category?: string;
  sub_category?: string;
  image_url?: string;
  thumbnail_url?: string;
  location_city?: string;
  artist_name?: string;
  subject_name?: string | null;
  community_id?: string | null;
  age_restriction?: string;
  tags?: string;
  is_featured?: boolean;
  bid_count?: number;
  view_count?: number;
  duration_minutes?: number;
  // Public sector
  is_public_sector?: boolean;
  is_free?: boolean;
  require_checkin?: boolean;
  locality_restricted?: string | null;
  deposit_amount?: number;
  no_show_policy?: string;
  cancellation_fee_tiers?: Array<{
    days_before: number;
    fee_pct: number;
  }> | null;
  discount_policies?:
    | Record<string, number>
    | Array<Record<string, unknown>>
    | null;
  resident_priority?: boolean;
  resident_priority_days?: number;
  nft_enabled?: boolean;
  // Regulation
  price_cap_multiplier?: number;
  require_identity_verification?: boolean;
  // Remainder policy
  remainder_strategy?: string;
  remainder_trigger_hours?: number;
  remainder_step_interval_min?: number;
  // Multi-session
  multi_max_wins_per_user?: number;
  multi_loser_bonus_weight?: number;
  multi_cross_session_dedup?: boolean;
  // Resale
  resale_enabled?: boolean;
  resale_max_markup_pct?: number;
  resale_royalty_pct?: number;
  resale_opens_at?: string | null;
  resale_closes_at?: string | null;
  // Organizer portal fields
  age_rating?: string | null;
  seat_type?: string;
  seat_map_url?: string | null;
  allocation_ratio?: number | null;
  delivery_method?: string;
  mobile_ticket_enabled?: boolean;
  ticket_display_info?: string | null;
  desired_open_date?: string | null;
  notice?: string | null;
  description_images?: string | null;
  participant_enabled?: boolean;
  board_types?: string | null;
  event_date_end?: string | null;
  // Sports-specific fields
  home_team?: string;
  away_team?: string;
  match_status?: string;
  broadcast_url?: string;
  broadcast_platform?: string;
  parking_info?: string;
  // Classical / Festival fields
  program_notes?: string;
  program_data?: EventProgramData;
  stage_info?: string;
  time_slot_enabled?: boolean;
  time_slot_capacity?: number | null;
  time_slot_duration_minutes?: number | null;
  // Computed / relationship fields
  organizer_name?: string | null;
  organizer_contact_email?: string | null;
  organizer_contact_phone?: string | null;
  blurhash?: string | null;
  image_variants?: Record<string, string> | null;
  // Globalization
  currency?: string;
  event_timezone?: string;
  // Seat tiers (loaded via relationship)
  seat_tiers?: SeatTierCompact[];
  primary_sale_mode?: string | null;
  // DICE+Laylo DNA (A1, A4)
  service_fee_rate?: number;
  brand_color?: string | null;
  brand_color_fg?: string | null;
  // UI-only virtual fields (not in backend schema)
  images?: string[];
  artist_image_url?: string;
}

export interface SearchParams {
  q?: string;
  category?: string;
  sub_category?: string;
  city?: string;
  date_from?: string;
  date_to?: string;
  price_min?: number;
  price_max?: number;
  status?: string;
  sort?: string;
  is_public_sector?: boolean;
  skip?: number;
  limit?: number;
}

/**
 * Matches backend CategoryCount schema: {category, count}.
 * For display labels, use CATEGORIES constant from @pickket/lib.
 */
export interface CategoryCount {
  category: string;
  count: number;
}

/**
 * Matches backend PriceAdviceResponse schema.
 */
export interface PriceAdvice {
  event_id: string;
  competition_level: number;
  avg_historical_price: number | null;
  fan_weight: number;
  weight_percentile: number;
  estimated_win_probability: number;
  suggested_min_bid: number;
  suggested_max_bid: number;
  suggestion_text: string;
}

export interface RankingEvent extends Event {
  rank: number;
  rank_change: number | null;
  is_new: boolean;
}

export interface MyEventStatus {
  has_ticket: boolean;
  ticket_count: number;
  has_lottery_entry: boolean;
  lottery_status: string | null;
  lottery_entry_id: string | null;
  invested_ap: number;
  lottery_tier_id: string | null;
  lottery_pool_id: string | null;
  lottery_group_size: number;
}

export interface SeatTier {
  id: string;
  event_id: string;
  name: string;
  capacity: number;
  base_price: number;
  sale_mode: string;
  face_price: number;
  sold_count: number;
  remaining: number;
  min_price: number;
  max_price_cap: number;
  bidding_opens_at: string | null;
  bidding_closes_at: string | null;
  seating_type?: string;
  section_name?: string | null;
  max_group_size?: number;
  fanclub_discount_pct?: number;
  lottery_application_hours?: number;
  allow_group_tickets?: boolean;
  view_description?: string | null;
  distance_from_stage?: number | null;
  view_rating?: number | null;
  view_image_url?: string | null;
  position_label?: string | null;
}

export interface PurchaseResult {
  success: boolean;
  order_id: string | null;
  ticket_ids: string[];
  sale_mode: string;
  unit_price: number;
  total_price: number;
  waitlist_position: number | null;
  message: string;
}
