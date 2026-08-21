import { z } from "zod";

// Note: z.preprocess creates ZodEffects which breaks react-hook-form Path<T> inference.
// Use z.coerce instead; 0 means "not set" for optional numeric fields.

export const tierSchema = z.object({
  name: z.string().min(1, "등급 이름을 입력하세요"),
  capacity: z.coerce.number().int().min(1, "1석 이상 입력하세요"),
  base_price: z.coerce.number().min(0, "0원 이상 입력하세요"),
  sale_mode: z.enum(["fixed_fcfs", "lottery"]).default("fixed_fcfs"),
  face_price: z.coerce.number().min(0).default(0),
  min_price: z.coerce.number().min(0).default(0),
  max_price_cap: z.coerce.number().min(0).default(0),
  lottery_application_hours: z.coerce.number().int().min(1).default(48),
  fanclub_discount_pct: z.coerce.number().min(0).max(100).default(0),
  allow_group_tickets: z.boolean().default(true),
  max_group_size: z.coerce.number().int().min(1).max(10).default(4),
  bidding_opens_at: z.string().optional(),
  bidding_closes_at: z.string().optional(),
  position_label: z.string().max(120).optional(),
  view_description: z.string().max(300).optional(),
  distance_from_stage: z.coerce.number().min(0).optional(),
  view_rating: z.coerce.number().int().min(0).max(5).optional(),
  view_image_url: z.string().url().optional().or(z.literal("")),
});

export const eventFormSchema = z
  .object({
    // Step 1: 기본 정보
    title: z.string().min(2, "제목을 2자 이상 입력하세요").max(300),
    description: z.string().optional(),
    category: z.string().min(1, "카테고리를 선택하세요"),
    sub_category: z.string().optional(),
    artist_name: z.string().optional(),
    venue: z.string().min(1, "장소를 입력하세요"),
    location_city: z.string().optional(),

    // Step 2: 좌석등급
    tiers: z.array(tierSchema).min(1, "최소 1개 등급을 추가하세요"),

    // Step 3: 판매 설정
    event_date: z.string().min(1, "공연 일시를 입력하세요"),
    bidding_opens_at: z.string().min(1, "응모 시작 시간을 입력하세요"),
    bidding_closes_at: z.string().min(1, "응모 마감 시간을 입력하세요"),
    total_seats: z.coerce.number().int().min(1, "1석 이상 입력하세요"),
    min_price: z.coerce.number().min(0).default(0),
    max_price: z.coerce.number().optional(),
    age_restriction: z.string().optional(),
    duration_minutes: z.coerce.number().int().min(1).optional(),
    price_cap_multiplier: z.coerce.number().min(1).default(2.0),
    require_identity_verification: z.boolean().default(true),
    multi_max_wins_per_user: z.coerce.number().int().min(1).default(2),
    multi_loser_bonus_weight: z.coerce.number().min(0).max(1).default(0.05),
    multi_cross_session_dedup: z.boolean().default(true),

    // Step 4: 리세일 & 정책
    resale_enabled: z.boolean().default(false),
    resale_max_markup_pct: z.coerce.number().min(0).default(0),
    resale_royalty_pct: z.coerce.number().min(0).max(100).default(0),
    resale_opens_at: z.string().optional(),
    resale_closes_at: z.string().optional(),
    remainder_strategy: z
      .enum(["discount_fcfs", "fcfs", "lottery", "none"])
      .default("discount_fcfs"),
    remainder_trigger_hours: z.coerce.number().int().min(1).default(72),
    remainder_step_interval_min: z.coerce.number().int().min(1).default(60),
    is_public_sector: z.boolean().default(false),
    is_free: z.boolean().default(false),
    require_checkin: z.boolean().default(false),
    locality_restricted: z.string().optional(),
    deposit_amount: z.coerce.number().min(0).default(0),
    no_show_policy: z.enum(["refund", "forfeit", "partial"]).default("refund"),

    // Step 5: 미디어
    image_url: z.string().url().optional().or(z.literal("")),
    thumbnail_url: z.string().url().optional().or(z.literal("")),
    tags: z.string().optional(),
    is_featured: z.boolean().default(false),

    // Step 6: 상세 정보 (주최자 포탈)
    age_rating: z.string().optional(),
    seat_type: z.enum(["assigned", "unassigned"]).default("assigned"),
    seat_map_url: z.string().url().optional().or(z.literal("")),
    allocation_ratio: z.coerce.number().min(0).max(100).optional(),
    delivery_method: z.enum(["mobile", "onsite", "delivery"]).default("mobile"),
    mobile_ticket_enabled: z.boolean().default(true),
    ticket_display_info: z.string().max(1000).optional(),
    desired_open_date: z.string().optional(),
    notice: z.string().optional(),
    description_images: z.string().optional(),
    participant_enabled: z.boolean().default(false),
    board_types: z.string().optional(),
    event_date_end: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.bidding_opens_at && data.bidding_closes_at) {
      if (new Date(data.bidding_opens_at) >= new Date(data.bidding_closes_at)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "응모 시작일은 마감일보다 빨라야 합니다",
          path: ["bidding_opens_at"],
        });
      }
    }
    if (data.bidding_closes_at && data.event_date) {
      if (new Date(data.bidding_closes_at) >= new Date(data.event_date)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "응모 마감일은 이벤트 날짜보다 빨라야 합니다",
          path: ["bidding_closes_at"],
        });
      }
    }
    if (data.resale_opens_at && data.resale_closes_at) {
      if (new Date(data.resale_opens_at) >= new Date(data.resale_closes_at)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "리세일 시작일은 마감일보다 빨라야 합니다",
          path: ["resale_opens_at"],
        });
      }
    }

    // 판매모드: fixed_fcfs, lottery, fanclub 3가지만 지원
  });

export type EventFormValues = z.infer<typeof eventFormSchema>;
export type TierFormValues = z.infer<typeof tierSchema>;

export const STEP_FIELDS: Record<number, (keyof EventFormValues)[]> = {
  0: ["title", "category", "venue"],
  1: ["tiers"],
  2: ["event_date", "bidding_opens_at", "bidding_closes_at", "total_seats"],
  3: [],
  4: [],
  5: [],
};
