/**
 * 성장 처방 엔진 (배치 F-1) — 순수 함수.
 *
 * 대시보드가 "현황만" 보여주던 아쉬움을 해소한다. 이벤트의 현재 지표를 읽어
 * "지금 하면 매출이 오르는 구체 행동"을 우선순위 순으로 처방한다.
 *
 * 원칙:
 * - 읽기 + 추천만. 자동 실행 없음(CTA 는 사람이 눌러 기존 기능으로 이동).
 * - 입력은 기존 v2 dashboard/reports·이벤트 요약이 이미 제공하는 데이터만 사용.
 * - 순수 함수 → vitest 로 케이스 검증(부수효과·I/O 없음).
 *
 * 규칙표 (docs/ui/dev-plans/BATCH-F-GROWTH-PRESCRIPTION.md §F-1):
 *  | 신호                          | 처방                              | CTA            |
 *  | 판매율 낮음 + D-day 임박       | 잔여 N석, 관심고객 리마인드 발송   | messages       |
 *  | pending 주문 다수             | 미결제 N건 결제 유도               | messages       |
 *  | 프로모 미설정 + 판매 정체      | 얼리버드 할인코드 생성             | promo-codes    |
 *  | 매진 임박(>90%)              | 대기열/파이널콜 검토               | waitlist       |
 *  | 미답변 문의 누적             | CS 에이전트 초안 검토              | inbox(고객문의) |
 *  | SEO 미완 + live              | 검색 노출 개선                     | publish        |
 */

/** 처방 우선순위 — 낮을수록 위(긴급/기회손실 큰 순). */
export type PrescriptionPriority = 1 | 2 | 3;

/** CTA 목적지 카테고리(테스트·분석용 안정 키). */
export type PrescriptionCta =
  | "messages"
  | "messages-pending"
  | "promo-codes"
  | "waitlist"
  | "inbox"
  | "publish";

export interface Prescription {
  /** 안정 식별자(중복 방지·테스트 매칭용). */
  id: string;
  priority: PrescriptionPriority;
  /** 처방 제목(행동). */
  title: string;
  /** 사유 — 반드시 수치 근거를 포함한다. */
  reason: string;
  /** 실행 버튼 문구. */
  ctaLabel: string;
  /** 실행 딥링크(기존 기능으로 이동만). */
  ctaHref: string;
  /** CTA 목적지 카테고리. */
  cta: PrescriptionCta;
}

/**
 * 처방 엔진 입력 — 전부 기존 대시보드/리포트/이벤트요약이 제공하는 값.
 * 값이 없으면(경량 조회 실패 등) 해당 신호 규칙은 건너뛴다.
 */
export interface PrescriptionInput {
  /** 이벤트 라우팅 id (딥링크 조립용). */
  eventId: string;
  /** 이벤트 상태 — 라이브일 때만 일부 규칙 활성(예: SEO). */
  status: "draft" | "live" | "paused" | "archived" | string;
  /** 총 정원(좌석). null 이면 판매율/잔여석·매진 규칙 비활성. */
  maxAttendees: number | null;
  /** 현재 판매(참석자) 수. */
  totalAttendees: number;
  /** 총 주문 수(정체 판정 보조). */
  totalOrders: number;
  /** 이벤트 시작까지 남은 일수(D-day). null 이면 D-day 규칙 비활성. */
  daysUntilStart: number | null;
  /** 미결제(pending) 주문 수. */
  pendingOrders: number;
  /** 활성 프로모 코드 수. */
  activePromoCount: number;
  /** 미답변(open) 문의 수. */
  openInquiries: number;
  /** SEO 메타데이터 완료 여부. null 이면 SEO 규칙 비활성(조회 실패). */
  seoComplete: boolean | null;
}

/** 판매율(0~1). 정원 미설정/0 이면 null. */
export function computeSellThrough(input: PrescriptionInput): number | null {
  if (input.maxAttendees === null || input.maxAttendees <= 0) return null;
  return input.totalAttendees / input.maxAttendees;
}

/** 잔여석. 정원 미설정이면 null. 음수는 0 으로 클램프(초과판매 방어). */
export function computeRemainingSeats(input: PrescriptionInput): number | null {
  if (input.maxAttendees === null || input.maxAttendees <= 0) return null;
  return Math.max(0, input.maxAttendees - input.totalAttendees);
}

// --- 임계값(규칙 상수, 한 곳에 모아 조정 용이) ---
const LOW_SELL_THROUGH = 0.5; // 판매율 50% 미만 = 낮음
const NEAR_DDAY_DAYS = 14; // D-14 이내 = 임박
const SOLD_OUT_NEAR = 0.9; // 90% 이상 = 매진 임박
const STALE_SELL_THROUGH = 0.3; // 30% 미만 = 판매 정체(프로모 유도 기준)
const MIN_PENDING = 3; // pending 결제 유도 최소 건수
const MIN_OPEN_INQUIRIES = 3; // 미답변 문의 누적 최소 건수

/**
 * 이벤트 지표를 읽어 우선순위 처방 리스트를 반환한다(순수 함수).
 * 처방이 없으면 빈 배열 → UI 는 "지금은 순조롭습니다" 긍정 빈상태.
 */
export function buildPrescriptions(input: PrescriptionInput): Prescription[] {
  const list: Prescription[] = [];
  const base = `/events/${input.eventId}`;
  const sellThrough = computeSellThrough(input);
  const remaining = computeRemainingSeats(input);
  const isLive = input.status === "live";

  // 1) 매진 임박(>90%) → 대기열/파이널콜 검토. (기회 최상단)
  if (sellThrough !== null && sellThrough >= SOLD_OUT_NEAR && remaining !== null && remaining > 0) {
    const pct = Math.round(sellThrough * 100);
    list.push({
      id: "near-sold-out",
      priority: 1,
      title: "대기열·파이널콜 검토",
      reason: `판매율 ${pct}% · 잔여 ${remaining}석. 매진이 임박했습니다.`,
      ctaLabel: "대기열 열기",
      ctaHref: `${base}/waitlist`,
      cta: "waitlist",
    });
  }

  // 2) 미결제(pending) 주문 다수 → 결제 유도. (놓친 매출 회수)
  if (input.pendingOrders >= MIN_PENDING) {
    list.push({
      id: "pending-orders",
      priority: 1,
      title: "미결제 주문 결제 유도",
      reason: `미결제 주문 ${input.pendingOrders}건. 결제 완료 안내를 보내면 회수 가능합니다.`,
      ctaLabel: "결제 유도 발송",
      // 결제 유도는 pending 세그먼트 대상 발송 화면으로 이동.
      ctaHref: `${base}/messages?compose=1&segment=pending`,
      cta: "messages-pending",
    });
  }

  // 3) 판매율 낮음 + D-day 임박 → 관심고객 리마인드.
  if (
    sellThrough !== null &&
    sellThrough < LOW_SELL_THROUGH &&
    remaining !== null &&
    remaining > 0 &&
    input.daysUntilStart !== null &&
    input.daysUntilStart >= 0 &&
    input.daysUntilStart <= NEAR_DDAY_DAYS
  ) {
    const pct = Math.round(sellThrough * 100);
    list.push({
      id: "low-sales-near-dday",
      priority: 2,
      title: "관심고객 리마인드 발송",
      reason: `D-${input.daysUntilStart} · 판매율 ${pct}% · 잔여 ${remaining}석. 관심 고객에게 리마인드로 전환을 끌어올리세요.`,
      ctaLabel: "리마인드 발송",
      ctaHref: `${base}/messages?compose=1&status=not_checked_in`,
      cta: "messages",
    });
  }

  // 4) 프로모 미설정 + 판매 정체 → 얼리버드 할인코드.
  if (
    input.activePromoCount === 0 &&
    sellThrough !== null &&
    sellThrough < STALE_SELL_THROUGH &&
    remaining !== null &&
    remaining > 0
  ) {
    const pct = Math.round(sellThrough * 100);
    list.push({
      id: "no-promo-stale",
      priority: 2,
      title: "얼리버드 할인코드 생성",
      reason: `판매율 ${pct}% · 할인코드 미설정. 얼리버드 코드로 초기 판매에 불을 붙이세요.`,
      ctaLabel: "할인코드 만들기",
      ctaHref: `${base}/promo-codes`,
      cta: "promo-codes",
    });
  }

  // 5) 미답변 문의 누적 → CS 초안 검토.
  if (input.openInquiries >= MIN_OPEN_INQUIRIES) {
    list.push({
      id: "open-inquiries",
      priority: 2,
      title: "미답변 문의 처리",
      reason: `미답변 문의 ${input.openInquiries}건. 빠른 응대가 전환율과 신뢰를 높입니다.`,
      ctaLabel: "문의 확인",
      ctaHref: `${base}/inbox`,
      cta: "inbox",
    });
  }

  // 6) SEO 미완 + live → 검색 노출 개선.
  if (isLive && input.seoComplete === false) {
    list.push({
      id: "seo-incomplete",
      priority: 3,
      title: "검색 노출 개선",
      reason: "판매 중이지만 SEO 메타데이터가 비어 있습니다. 검색·SNS 공유 노출을 위해 생성하세요.",
      ctaLabel: "SEO 생성",
      ctaHref: `${base}/publish`,
      cta: "publish",
    });
  }

  // 우선순위 오름차순(1 최상단). 동순위는 삽입 순서(위 규칙 배치 = 기회 크기 순) 보존.
  return list.sort((a, b) => a.priority - b.priority);
}
