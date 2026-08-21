// ─── Locale Resolution ──────────────────────────────────────────────────────

/** Map short app locale codes (next-intl) to full Intl locale strings. */
const LOCALE_MAP: Record<string, string> = {
  ko: "ko-KR",
  en: "en-US",
  ja: "ja-JP",
  "zh-CN": "zh-CN",
  fr: "fr-FR",
  ru: "ru-RU",
  vi: "vi-VN",
};

/** Default currency per app locale. */
const LOCALE_CURRENCY_MAP: Record<string, string> = {
  ko: "KRW",
  ja: "JPY",
  en: "USD",
  fr: "EUR",
  ru: "RUB",
  vi: "VND",
  "zh-CN": "CNY",
};

/**
 * Resolve a short app locale (e.g. "ko") or full Intl locale (e.g. "ko-KR")
 * to a full Intl locale string. Defaults to "ko-KR" when omitted.
 */
export function resolveIntlLocale(locale?: string): string {
  if (!locale) return "ko-KR";
  return LOCALE_MAP[locale] ?? locale;
}

/** Get the default currency code for an app locale. */
export function localeToCurrency(locale?: string): string {
  if (!locale) return "KRW";
  return LOCALE_CURRENCY_MAP[locale] ?? "KRW";
}

// ─── PII Masking ────────────────────────────────────────────────────────────

/**
 * Mask an email address for display in list/table views.
 *
 * Mirrors the backend helper in `backend/app/core/pii.py:mask_email`
 * so v2 FE/BE agree on the output shape (`u***@domain.com`).
 *
 * Behavior:
 *  - null/undefined/empty → ""
 *  - value without "@" → returned unchanged (caller-supplied fallback like "-")
 *  - local-part ≤ 1 char  → local-part kept as-is
 *  - otherwise            → first char + "***"
 *
 * Use this in admin list columns; detail/drawer views may render the
 * plaintext email where a staff action requires it.
 */
export function maskEmail(email?: string | null): string {
  if (!email) return "";
  if (!email.includes("@")) return email;
  const [local, domain] = email.split("@", 2);
  if (!local || !domain) return email;
  const maskedLocal = local.length <= 1 ? local : `${local[0]}***`;
  return `${maskedLocal}@${domain}`;
}

// ─── Number / KRW Formatting ────────────────────────────────────────────────

export function formatKRW(amount: number, locale?: string): string {
  return new Intl.NumberFormat(resolveIntlLocale(locale), {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(dateStr: string, locale?: string): string {
  return new Date(dateStr).toLocaleDateString(resolveIntlLocale(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateShort(dateStr: string, locale?: string): string {
  return new Date(dateStr).toLocaleDateString(resolveIntlLocale(locale), {
    month: "short",
    day: "numeric",
  });
}

export function formatShortDate(
  dateStr?: string | null,
  locale?: string,
): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString(resolveIntlLocale(locale), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: "준비중",
    pending_review: "검토대기",
    under_review: "검토중",
    revision_requested: "수정요청",
    approved: "승인완료",
    bidding_open: "응모중",
    bidding_closed: "응모마감",
    allocating: "배분중",
    allocated: "배분완료",
    completed: "종료",
    cancelled: "취소",
  };
  return map[status] || status;
}

export function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    pending_review: "bg-amber-100 text-amber-700",
    under_review: "bg-blue-100 text-blue-700",
    revision_requested: "bg-yellow-100 text-yellow-700",
    approved: "bg-teal-100 text-teal-700",
    bidding_open: "bg-green-100 text-green-700",
    bidding_closed: "bg-yellow-100 text-yellow-700",
    allocating: "bg-blue-100 text-blue-700",
    allocated: "bg-purple-100 text-purple-700",
    completed: "bg-gray-100 text-gray-600",
    cancelled: "bg-red-100 text-red-700",
  };
  return map[status] || "bg-gray-100 text-gray-700";
}

export function getBidStatusLabel(status: string): string {
  const map: Record<string, string> = {
    active: "응모중",
    pending: "추첨 대기",
    cancelled: "취소",
    won: "당첨",
    lost: "미당첨",
    waitlisted: "대기",
    rejected: "차단",
  };
  return map[status] || status;
}

export function getBidStatusColor(status: string): string {
  const map: Record<string, string> = {
    active: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    pending:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    cancelled: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    won: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    lost: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    waitlisted:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    rejected: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };
  return map[status] || "bg-gray-100 text-gray-700";
}

/**
 * 백엔드(point_lottery/fanclub_presale) ↔ 프론트(lottery/fanclub) 정규화.
 * 어느 쪽 값이 와도 프론트엔드 기준 코드값으로 통일.
 */
export function normalizeSaleMode(mode: string): string {
  const aliases: Record<string, string> = {
    point_lottery: "lottery",
    fanclub_presale: "fanclub",
  };
  return aliases[mode] ?? mode;
}

export function getSaleModeLabel(mode: string): string {
  const map: Record<string, string> = {
    fixed_fcfs: "선착순",
    lottery: "공정 배분",
    fanclub: "멤버십 선판매",
  };
  return map[normalizeSaleMode(mode)] || mode;
}

export function getSaleModeDescription(mode: string): string {
  const map: Record<string, string> = {
    fixed_fcfs: "정가에 선착순으로 구매합니다",
    lottery: "AP 가중 공정 추첨으로 배분합니다",
    fanclub: "멤버십 선판매입니다",
  };
  return map[normalizeSaleMode(mode)] || "";
}

export function getSeatingTypeLabel(type: string): string {
  const map: Record<string, string> = {
    assigned: "지정석",
    general_admission: "자유석",
    standing: "스탠딩",
  };
  return map[type] || type;
}

export function formatSeatLabel(
  section: string,
  row: number,
  seat: number,
): string {
  return `${section}구역 ${row}열 ${seat}번`;
}

// ─── Currency Formatting ────────────────────────────────────────────────────

export function formatCurrency(
  amount: number,
  currency = "KRW",
  locale?: string,
): string {
  const currencyLocaleMap: Record<string, string> = {
    KRW: "ko-KR",
    JPY: "ja-JP",
    USD: "en-US",
    EUR: "fr-FR",
    GBP: "en-GB",
    CNY: "zh-CN",
    THB: "th-TH",
    SGD: "en-SG",
    AUD: "en-AU",
    CAD: "en-CA",
  };
  const loc = locale
    ? resolveIntlLocale(locale)
    : currencyLocaleMap[currency] || "en-US";
  return new Intl.NumberFormat(loc, {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KRW" || currency === "JPY" ? 0 : 2,
  }).format(amount);
}

// ─── Timezone-aware Event Time Formatting ───────────────────────────────────

export function formatEventTime(
  datetime: string | Date,
  eventTimezone: string = "Asia/Seoul",
  viewerTimezone?: string,
  locale?: string,
): { eventLocal: string; viewerLocal?: string } {
  const date = typeof datetime === "string" ? new Date(datetime) : datetime;
  const intlLocale = resolveIntlLocale(locale);

  const eventLocal = new Intl.DateTimeFormat(intlLocale, {
    timeZone: eventTimezone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);

  if (!viewerTimezone || viewerTimezone === eventTimezone) {
    return { eventLocal };
  }

  const viewerLocal = new Intl.DateTimeFormat(intlLocale, {
    timeZone: viewerTimezone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);

  return { eventLocal, viewerLocal };
}
