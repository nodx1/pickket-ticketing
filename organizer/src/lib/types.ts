export type ID = string;
export type ISODateString = string;
export type Timestamp = string;

export type UserRole = "owner" | "admin" | "organizer" | "staff" | "check_in";
export type InvitationStatus = "pending" | "accepted" | "expired" | "cancelled";
export type SessionStatus = "active" | "revoked" | "expired";
export type EventStatus = "draft" | "pending_review" | "rejected" | "live" | "paused" | "archived";
export type EventType =
  | "concert"
  | "festival"
  | "conference"
  | "exhibition"
  | "mice"
  | "workshop"
  | "fan_meeting"
  | "flea_market"
  | "lecture"
  | "preview"
  | "local_festival"
  | "party"
  | "networking";
export type AgeRating = "all" | "12+" | "15+" | "18+";
export type ProductType = "ticket" | "addon" | "bundle" | "donation";
export type ProductVisibility = "public" | "private" | "hidden";
export type OrderStatus = "pending" | "completed" | "cancelled" | "refunded" | "partially_refunded" | "expired";
export type FeePlanType = "percentage" | "fixed" | "percentage_plus_fixed";
export type PaymentMethod =
  | "toss"
  | "kakaopay"
  | "naverpay"
  | "card"
  | "bank_transfer"
  | "offline";
export type PaymentStatus = "pending" | "paid" | "failed" | "cancelled" | "refunded";
export type AttendeeStatus = "pending" | "confirmed" | "cancelled" | "checked_in";
export type QuestionType = "short_text" | "long_text" | "single_choice" | "multiple_choice" | "checkbox";
export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "login"
  | "logout"
  | "invite"
  | "refund"
  | "check_in"
  | "raffle_draw"
  // 🔴 개인정보 CSV 내려받기 (2026-07-29 감사). 참석자·주문·리포트·체크인 export 는
  //    이름·이메일·전화를 평문으로 내보내는데 누가 언제 받아갔는지 기록이 없었다.
  //    계정 탈취나 내부자 오남용이 있어도 사후 추적이 불가능했다.
  | "export";
export type EmailTemplateType = "order_confirmation" | "event_reminder" | "refund_notice" | "custom";
export type RefundType = "full" | "partial";
export type TaxInvoiceStatus = "requested" | "issued" | "cancelled";
export type NotificationType = "refund_request" | "sold_out" | "payment_failed" | "new_order" | "check_in_milestone" | "system" | "ai_review" | "ai_complete" | "waitlist_offer";
export type CheckInListStatus = "draft" | "active" | "closed";
export type CheckInMethod = "qr" | "manual" | "search";
export type PromoCodeType = "fixed" | "percentage";
export type SaleChannel = "self" | "marketplace";
export type FeatureKey =
  | "sale_mode"
  | "bot_detection"
  | "group_booking"
  | "participants"
  | "facilities"
  | "rehearsal"
  | "compliance"
  | "bridge_page"
  | "packages"
  | "final_call"
  | "ticket_issuance";
export type MessageChannel = "email" | "sms" | "alimtalk" | "push";
export type MessageStatus = "draft" | "scheduled" | "sent" | "failed";
export type CapacityAssignmentStatus = "active" | "paused";
export type WaitlistStatus = "waiting" | "offered" | "converted" | "cancelled" | "expired";
export type WebhookStatus = "active" | "disabled";
export type AffiliateStatus = "active" | "inactive";
export type SeatMapStatus = "draft" | "published" | "archived";
export type SeatStatus = "available" | "held" | "reserved" | "blocked";
export type GroupBookingStatus = "pending" | "confirmed" | "cancelled";
export type TicketDesignStatus = "draft" | "published";
export type SettlementStatus = "pending" | "processing" | "completed";

export interface TimestampFields {
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Account extends TimestampFields {
  id: ID;
  name: string;
  slug: string;
  businessNumber: string | null;
  contactEmail: string;
  contactPhone: string | null;
  ownerUserId: ID;
  feePlanId: ID | null;
  currency: "KRW";
  timezone: "Asia/Seoul";
  isActive: boolean;
}

export interface User extends TimestampFields {
  id: ID;
  accountId: ID;
  email: string;
  name: string;
  role: UserRole;
  phone: string | null;
  passwordHash: string;
  isActive: boolean;
  mfaEnabled: boolean;
  lastLoginAt: Timestamp | null;
  /**
   * v2 canonical user id (= JWT sub). 인증코어가 세션 구성 시 토큰 payload.sub 로 채운다.
   * 레벨2 영역D: resolveOrganizerRef 가 go DB(accounts JOIN users) 재조회 없이 이 값을
   * organizer_ref 로 쓰기 위한 앵커. go users.v2_user_id 와 동일 값(로그인 시 매핑됨).
   */
  v2UserId?: ID | null;
}

export interface Session extends TimestampFields {
  id: ID;
  accountId: ID;
  userId: ID;
  tokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Timestamp;
  status: SessionStatus;
}

export interface Invitation extends TimestampFields {
  id: ID;
  accountId: ID;
  name: string | null;
  email: string;
  role: UserRole;
  invitedByUserId: ID;
  token: string;
  status: InvitationStatus;
  expiresAt: Timestamp;
  acceptedAt: Timestamp | null;
}

export interface Notification {
  id: ID;
  accountId: ID;
  eventId: ID | null;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  metadata: JsonValue;
  createdAt: Timestamp;
}

export interface Organizer extends TimestampFields {
  id: ID;
  accountId: ID;
  name: string;
  slug: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  logoUrl: string | null;
  isPublished: boolean;
}

export type OrganizerRole = "host" | "coordinator" | "sponsor";

export const ORGANIZER_ROLE_LABELS: Record<OrganizerRole, string> = {
  host: "주최",
  coordinator: "주관",
  sponsor: "후원",
};

export interface EventOrganizer {
  id: ID;
  eventId: ID;
  organizerId: ID;
  role: OrganizerRole;
  displayOrder: number;
  organizerName?: string;
  organizerLogoUrl?: string | null;
}

export interface Event extends TimestampFields {
  id: ID;
  accountId: ID;
  organizerId: ID;
  title: string;
  slug: string;
  summary: string | null;
  description: string | null;
  venueName: string | null;
  venueAddress: string | null;
  eventType: EventType;
  ageRating: AgeRating;
  maxAttendees: number | null;
  isOnline: boolean;
  startsAt: Timestamp;
  endsAt: Timestamp;
  timezone: "Asia/Seoul";
  status: EventStatus;
  homepageUrl: string | null;
  heroImageUrl: string | null;
  transportInfo: string | null;
  parkingInfo: string | null;
  enabledFeatures: FeatureKey[];
}

export interface ProductCategory extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  name: string;
  description: string | null;
  sortOrder: number;
}

export interface Product extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  categoryId: ID | null;
  name: string;
  description: string | null;
  type: ProductType;
  visibility: ProductVisibility;
  price: number;
  saleStartsAt: Timestamp | null;
  saleEndsAt: Timestamp | null;
  stock: number | null;
  minPerOrder: number;
  maxPerOrder: number | null;
  taxIncluded: boolean;
  taxRate: number;
  sortOrder: number;
  isActive: boolean;
}

export interface Order extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  orderNumber: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string | null;
  totalAmount: number;
  paidAmount: number;
  refundAmount: number;
  platformFee: number;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paymentReference: string | null;
  memo: string | null;
  expiresAt: Timestamp | null;
  orderedAt: Timestamp;
}

export interface PlatformFeePlan extends TimestampFields {
  id: ID;
  name: string;
  description: string | null;
  feeType: FeePlanType;
  feePercentage: number;
  feeFixed: number;
  minFee: number;
  maxFee: number | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface Settlement extends TimestampFields {
  id: ID;
  accountId: ID;
  periodStart: ISODateString;
  periodEnd: ISODateString;
  grossAmount: number;
  platformFee: number;
  refundAmount: number;
  netAmount: number;
  orderCount: number;
  status: SettlementStatus;
  paidAt: Timestamp | null;
  bankName: string | null;
  bankAccount: string | null;
  bankHolder: string | null;
  memo: string | null;
}

export interface OrderItem extends TimestampFields {
  id: ID;
  accountId: ID;
  orderId: ID;
  productId: ID;
  unitPrice: number;
  quantity: number;
  totalAmount: number;
}

export interface Attendee extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  orderId: ID;
  orderItemId: ID;
  ticketNumber: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: AttendeeStatus;
  checkedInAt: Timestamp | null;
}

export interface EventQuestion extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  label: string;
  questionType: QuestionType;
  isRequired: boolean;
  options: string[];
  sortOrder: number;
}

export interface AuditLog extends TimestampFields {
  id: ID;
  accountId: ID | null;
  userId: ID | null;
  action: AuditAction;
  tableName: string;
  recordId: ID | null;
  changes: JsonValue | null;
  ipAddress: string | null;
}

export interface EmailTemplate extends TimestampFields {
  id: ID;
  accountId: ID;
  name: string;
  templateType: EmailTemplateType;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  isDefault: boolean;
}

export interface RefundPolicy extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  title: string;
  description: string | null;
  refundType: RefundType;
  rules: JsonValue;
}

export interface TaxInvoice extends TimestampFields {
  id: ID;
  accountId: ID;
  orderId: ID;
  businessNumber: string;
  companyName: string;
  amount: number;
  status: TaxInvoiceStatus;
  issuedAt: Timestamp | null;
}

export interface CheckInList extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  name: string;
  status: CheckInListStatus;
  opensAt: Timestamp | null;
  closesAt: Timestamp | null;
}

export interface CheckInLog extends TimestampFields {
  id: ID;
  accountId: ID;
  checkInListId: ID;
  attendeeId: ID;
  checkedInByUserId: ID | null;
  method: CheckInMethod;
  note: string | null;
}

export interface PromoCode extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  code: string;
  promoType: PromoCodeType;
  discountValue: number;
  usageLimit: number | null;
  usedCount: number;
  startsAt: Timestamp | null;
  endsAt: Timestamp | null;
  isActive: boolean;
}

export interface EventMessage extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  title: string;
  channel: MessageChannel;
  status: MessageStatus;
  body: string;
  scheduledAt: Timestamp | null;
  sentAt: Timestamp | null;
}

export interface CapacityAssignment extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  productId: ID;
  capacity: number;
  usedCapacity: number;
  status: CapacityAssignmentStatus;
}

export interface WaitlistEntry extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  productId: ID;
  name: string;
  email: string;
  phone: string | null;
  status: WaitlistStatus;
  offeredAt: Timestamp | null;
  expiresAt: Timestamp | null;
}

export interface Webhook extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID | null;
  name: string;
  endpointUrl: string;
  signingSecret: string;
  status: WebhookStatus;
  subscribedEvents: string[];
}

export interface Affiliate extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  name: string;
  code: string;
  commissionRate: number;
  status: AffiliateStatus;
}

export interface SeatMap extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  name: string;
  status: SeatMapStatus;
  mapData: JsonValue;
}

export interface Seat extends TimestampFields {
  id: ID;
  accountId: ID;
  seatMapId: ID;
  section: string;
  row: string;
  seatNumber: string;
  status: SeatStatus;
  productId: ID | null;
}

export interface GroupBooking extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  organizationName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  attendeeCount: number;
  status: GroupBookingStatus;
}

export interface TicketDesign extends TimestampFields {
  id: ID;
  accountId: ID;
  eventId: ID;
  name: string;
  status: TicketDesignStatus;
  canvasJson: JsonValue;
  previewImageUrl: string | null;
}
