/**
 * 트랙 1.11 — 좌석 시스템 i18n + 통화 환산 (제한적)
 *
 * 전체 i18n 인프라가 무거우므로 좌석/etcs 라벨 + 통화 환산만 별도 모듈.
 * - 한국어 / 영어 / 일본어 / 중국어 4종 지원
 * - 통화: KRW 기본, USD/JPY/CNY 환산 (실시간 환율 캐시 1h)
 * - locale 결정: Accept-Language 헤더 → 'ko' / 'en' / 'ja' / 'zh'
 */

export type SeatLocale = "ko" | "en" | "ja" | "zh";
export type Currency = "KRW" | "USD" | "JPY" | "CNY";

interface LabelMap {
  selectSeat: string;
  available: string;
  held: string;
  sold: string;
  blocked: string;
  selected: string;
  bestAvailable: string;
  companion: string;
  watch: string;
  compare: string;
  holdExpired: string;
  holdRemaining: string;
  pinchHint: string;
  longPressHint: string;
  stage: string;
  exit: string;
  aisle: string;
  vipLounge: string;
  wheelchair: string;
}

const LABELS: Record<SeatLocale, LabelMap> = {
  ko: {
    selectSeat: "좌석 선택",
    available: "선택 가능",
    held: "선택 중",
    sold: "판매 완료",
    blocked: "이용 불가",
    selected: "내 선택",
    bestAvailable: "최적 좌석 자동 선택",
    companion: "친구와 함께 예매",
    watch: "관심 좌석 등록",
    compare: "좌석 비교",
    holdExpired: "좌석 잠금이 만료되었습니다",
    holdRemaining: "잔여 시간",
    pinchHint: "두 손가락으로 확대/축소",
    longPressHint: "길게 눌러 시야 미리보기",
    stage: "무대",
    exit: "출구",
    aisle: "통로",
    vipLounge: "VIP 라운지",
    wheelchair: "휠체어석",
  },
  en: {
    selectSeat: "Select seat",
    available: "Available",
    held: "Holding",
    sold: "Sold out",
    blocked: "Unavailable",
    selected: "Your seat",
    bestAvailable: "Best available",
    companion: "Book with friends",
    watch: "Watch seat",
    compare: "Compare",
    holdExpired: "Your seat hold has expired",
    holdRemaining: "Time remaining",
    pinchHint: "Pinch to zoom",
    longPressHint: "Long-press for view preview",
    stage: "Stage",
    exit: "Exit",
    aisle: "Aisle",
    vipLounge: "VIP Lounge",
    wheelchair: "Wheelchair",
  },
  ja: {
    selectSeat: "座席選択",
    available: "選択可能",
    held: "選択中",
    sold: "売り切れ",
    blocked: "利用不可",
    selected: "選択中",
    bestAvailable: "おすすめ座席",
    companion: "友達と一緒に予約",
    watch: "お気に入り",
    compare: "比較",
    holdExpired: "座席のロックが期限切れになりました",
    holdRemaining: "残り時間",
    pinchHint: "ピンチでズーム",
    longPressHint: "長押しで視界プレビュー",
    stage: "ステージ",
    exit: "出口",
    aisle: "通路",
    vipLounge: "VIPラウンジ",
    wheelchair: "車椅子席",
  },
  zh: {
    selectSeat: "选择座位",
    available: "可选",
    held: "选择中",
    sold: "已售",
    blocked: "不可用",
    selected: "已选",
    bestAvailable: "最佳座位推荐",
    companion: "和朋友一起订",
    watch: "关注座位",
    compare: "比较",
    holdExpired: "座位锁定已过期",
    holdRemaining: "剩余时间",
    pinchHint: "双指缩放",
    longPressHint: "长按查看视野",
    stage: "舞台",
    exit: "出口",
    aisle: "通道",
    vipLounge: "VIP休息室",
    wheelchair: "轮椅座位",
  },
};

export function getSeatLabels(locale: SeatLocale = "ko"): LabelMap {
  return LABELS[locale] ?? LABELS.ko;
}

/**
 * Accept-Language 헤더에서 SeatLocale 결정.
 */
export function detectLocale(acceptLanguage: string | null): SeatLocale {
  if (!acceptLanguage) return "ko";
  const lower = acceptLanguage.toLowerCase();
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("zh")) return "zh";
  return "ko";
}

/**
 * 환율 (1 KRW 당 외화 단위) — 1시간 캐시.
 * 환율 API 장애 시 KRW 만 표시 (fallback).
 */
let exchangeCache: {
  rates: Record<Currency, number>;
  expiresAt: number;
} | null = null;

const FALLBACK_RATES: Record<Currency, number> = {
  KRW: 1,
  USD: 1 / 1380, // 1 USD ≈ 1380 KRW
  JPY: 1 / 9.2, // 1 JPY ≈ 9.2 KRW
  CNY: 1 / 195, // 1 CNY ≈ 195 KRW
};

export async function getExchangeRates(): Promise<Record<Currency, number>> {
  if (exchangeCache && exchangeCache.expiresAt > Date.now()) {
    return exchangeCache.rates;
  }
  // 실제 환율 API 연결은 후속 (FALLBACK 사용)
  exchangeCache = {
    rates: FALLBACK_RATES,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  return FALLBACK_RATES;
}

export function localeToCurrency(locale: SeatLocale): Currency {
  switch (locale) {
    case "en":
      return "USD";
    case "ja":
      return "JPY";
    case "zh":
      return "CNY";
    default:
      return "KRW";
  }
}

const CURRENCY_SYMBOL: Record<Currency, string> = {
  KRW: "₩",
  USD: "$",
  JPY: "¥",
  CNY: "¥",
};

/**
 * KRW 금액을 사용자 locale 통화로 환산해 표시.
 * 예: convertPrice(50000, "en") → "$36"
 */
export async function convertPrice(
  krw: number,
  locale: SeatLocale,
): Promise<string> {
  const currency = localeToCurrency(locale);
  if (currency === "KRW") {
    return `₩${krw.toLocaleString("ko-KR")}`;
  }
  const rates = await getExchangeRates();
  const converted = krw * rates[currency];
  // KRW 는 위에서 early return 되었으므로 여기서는 USD/JPY/CNY 만 도달.
  // JPY 는 정수, USD/CNY 는 소수 둘째자리까지.
  const rounded =
    currency === "JPY"
      ? Math.round(converted)
      : Math.round(converted * 100) / 100;
  return `${CURRENCY_SYMBOL[currency]}${rounded.toLocaleString(locale)}`;
}
