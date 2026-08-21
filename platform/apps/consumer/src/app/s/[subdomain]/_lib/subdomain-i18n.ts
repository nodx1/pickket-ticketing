/**
 * Lightweight i18n for subdomain pages.
 *
 * These pages live outside the [locale] route group so next-intl
 * is not available.  Language is detected from:
 *   1. `?lang=` search param
 *   2. `Accept-Language` header
 *   3. fallback → "ko"
 */

export type SubdomainLocale = "ko" | "en" | "ja" | "zh-CN";

const SUPPORTED: SubdomainLocale[] = ["ko", "en", "ja", "zh-CN"];

// ─── Translation dictionary ─────────────────────────────────────────────────

const translations: Record<string, Record<SubdomainLocale, string>> = {
  // Booking / ticketing
  "seats.select": {
    ko: "좌석 선택",
    en: "Select Seats",
    ja: "席選択",
    "zh-CN": "选择座位",
  },
  "booking.cta": {
    ko: "예매하기",
    en: "Book Now",
    ja: "予約する",
    "zh-CN": "立即预订",
  },
  "booking.lottery": {
    ko: "추첨 응모하기",
    en: "Enter Lottery",
    ja: "抽選に応募する",
    "zh-CN": "参与抽签",
  },
  "booking.quantity": {
    ko: "수량",
    en: "Quantity",
    ja: "数量",
    "zh-CN": "数量",
  },
  "booking.total": {
    ko: "합계",
    en: "Total",
    ja: "合計",
    "zh-CN": "合计",
  },
  "booking.price": {
    ko: "가격",
    en: "Price",
    ja: "価格",
    "zh-CN": "价格",
  },
  "booking.soldOut": {
    ko: "매진",
    en: "Sold Out",
    ja: "売り切れ",
    "zh-CN": "售罄",
  },
  "booking.available": {
    ko: "예매 가능",
    en: "Available",
    ja: "予約可能",
    "zh-CN": "可预订",
  },
  "booking.closed": {
    ko: "예매 마감",
    en: "Booking Closed",
    ja: "予約終了",
    "zh-CN": "预订已结束",
  },

  // Community / trust
  "community.label": {
    ko: "커뮤니티",
    en: "Community",
    ja: "コミュニティ",
    "zh-CN": "社区",
  },
  "trust.fairAllocation": {
    ko: "공정 배분",
    en: "Fair Allocation",
    ja: "公正配分",
    "zh-CN": "公平分配",
  },
  "trust.verified": {
    ko: "인증됨",
    en: "Verified",
    ja: "認証済み",
    "zh-CN": "已认证",
  },
  "trust.officialPartner": {
    ko: "공식 파트너",
    en: "Official Partner",
    ja: "公式パートナー",
    "zh-CN": "官方合作伙伴",
  },
  "trust.securePayment": {
    ko: "안전 결제",
    en: "Secure Payment",
    ja: "安全決済",
    "zh-CN": "安全支付",
  },

  // Event details
  "event.date": {
    ko: "일시",
    en: "Date",
    ja: "日時",
    "zh-CN": "日期",
  },
  "event.venue": {
    ko: "장소",
    en: "Venue",
    ja: "会場",
    "zh-CN": "场地",
  },
  "event.organizer": {
    ko: "주최",
    en: "Organizer",
    ja: "主催",
    "zh-CN": "主办方",
  },
  "event.details": {
    ko: "상세 정보",
    en: "Details",
    ja: "詳細",
    "zh-CN": "详情",
  },
  "event.tickets": {
    ko: "티켓",
    en: "Tickets",
    ja: "チケット",
    "zh-CN": "票务",
  },
  "event.reviews": {
    ko: "후기",
    en: "Reviews",
    ja: "レビュー",
    "zh-CN": "评价",
  },

  // General UI
  "ui.loading": {
    ko: "로딩 중...",
    en: "Loading...",
    ja: "読み込み中...",
    "zh-CN": "加载中...",
  },
  "ui.error": {
    ko: "오류가 발생했습니다",
    en: "An error occurred",
    ja: "エラーが発生しました",
    "zh-CN": "发生错误",
  },
  "ui.retry": {
    ko: "다시 시도",
    en: "Retry",
    ja: "再試行",
    "zh-CN": "重试",
  },
  "ui.close": {
    ko: "닫기",
    en: "Close",
    ja: "閉じる",
    "zh-CN": "关闭",
  },
  "ui.share": {
    ko: "공유하기",
    en: "Share",
    ja: "シェアする",
    "zh-CN": "分享",
  },
  "ui.login": {
    ko: "로그인",
    en: "Log In",
    ja: "ログイン",
    "zh-CN": "登录",
  },
  "ui.signup": {
    ko: "회원가입",
    en: "Sign Up",
    ja: "新規登録",
    "zh-CN": "注册",
  },
};

// ─── Locale detection ───────────────────────────────────────────────────────

function parseAcceptLanguage(header: string): SubdomainLocale | null {
  // Accept-Language: ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7
  const parts = header
    .split(",")
    .map((p) => {
      const [lang, qPart] = p.trim().split(";");
      const q = qPart ? parseFloat(qPart.replace("q=", "")) : 1;
      return { lang: lang.trim().toLowerCase(), q };
    })
    .sort((a, b) => b.q - a.q);

  for (const { lang } of parts) {
    // Exact match first (e.g. "zh-cn")
    const exact = SUPPORTED.find((s) => s.toLowerCase() === lang);
    if (exact) return exact;
    // Prefix match (e.g. "ja-jp" → "ja", "zh" → "zh-CN")
    const prefix = lang.split("-")[0];
    if (prefix === "zh") return "zh-CN";
    const match = SUPPORTED.find((s) => s === prefix);
    if (match) return match;
  }
  return null;
}

/**
 * Detect the subdomain locale from request context.
 *
 * Priority: ?lang= param → Accept-Language header → "ko"
 */
export function getSubdomainLocale(
  searchParams?: URLSearchParams | null,
  acceptLanguage?: string | null,
): SubdomainLocale {
  // 1. Explicit ?lang= param
  if (searchParams) {
    const langParam = searchParams.get("lang")?.toLowerCase();
    if (langParam) {
      const exact = SUPPORTED.find((s) => s.toLowerCase() === langParam);
      if (exact) return exact;
      // Prefix match for param too
      const prefix = langParam.split("-")[0];
      if (prefix === "zh") return "zh-CN";
      const match = SUPPORTED.find((s) => s === prefix);
      if (match) return match;
    }
  }

  // 2. Accept-Language header
  if (acceptLanguage) {
    const detected = parseAcceptLanguage(acceptLanguage);
    if (detected) return detected;
  }

  // 3. Default
  return "ko";
}

/**
 * Translate a key to the given locale.
 * Falls back to Korean, then returns the key itself.
 */
export function t(key: string, locale: SubdomainLocale): string {
  const entry = translations[key];
  if (!entry) return key;
  return entry[locale] ?? entry.ko ?? key;
}

/** All supported locales — useful for generating static params or select options. */
export const SUPPORTED_LOCALES = SUPPORTED;
