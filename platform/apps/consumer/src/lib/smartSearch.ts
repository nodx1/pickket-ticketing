import { CATEGORIES, CITIES } from "@pickket/lib";

export interface ParsedQuery {
  q?: string;
  category?: string;
  city?: string;
  date_from?: string;
  date_to?: string;
  price_min?: number;
  price_max?: number;
}

function toISODate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getToday(): Date {
  return new Date();
}

function getStartOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
}

function getEndOfWeek(date: Date): Date {
  const start = getStartOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return end;
}

export function parseSmartQuery(input: string): ParsedQuery {
  const result: ParsedQuery = {};
  let remaining = input.trim();

  // 1. Match categories
  for (const cat of CATEGORIES) {
    const patterns = [cat.label, cat.labelEn.toLowerCase(), cat.slug];
    for (const pattern of patterns) {
      const regex = new RegExp(pattern, "gi");
      if (regex.test(remaining)) {
        result.category = cat.slug;
        remaining = remaining.replace(regex, "").trim();
        break;
      }
    }
    if (result.category) break;
  }

  // 2. Match cities
  for (const city of CITIES) {
    const regex = new RegExp(city, "g");
    if (regex.test(remaining)) {
      result.city = city;
      remaining = remaining.replace(regex, "").trim();
      break;
    }
  }

  // 3. Match date expressions
  const today = getToday();

  // "내일"
  if (/내일/.test(remaining)) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    result.date_from = toISODate(tomorrow);
    result.date_to = toISODate(tomorrow);
    remaining = remaining.replace(/내일/g, "").trim();
  }
  // "오늘"
  else if (/오늘/.test(remaining)) {
    result.date_from = toISODate(today);
    result.date_to = toISODate(today);
    remaining = remaining.replace(/오늘/g, "").trim();
  }
  // "이번주"
  else if (/이번\s*주/.test(remaining)) {
    result.date_from = toISODate(today);
    result.date_to = toISODate(getEndOfWeek(today));
    remaining = remaining.replace(/이번\s*주/g, "").trim();
  }
  // "다음주"
  else if (/다음\s*주/.test(remaining)) {
    const nextWeekStart = new Date(getStartOfWeek(today));
    nextWeekStart.setDate(nextWeekStart.getDate() + 7);
    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setDate(nextWeekEnd.getDate() + 6);
    result.date_from = toISODate(nextWeekStart);
    result.date_to = toISODate(nextWeekEnd);
    remaining = remaining.replace(/다음\s*주/g, "").trim();
  }
  // "이번달" / "이번 달"
  else if (/이번\s*달/.test(remaining)) {
    result.date_from = toISODate(today);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    result.date_to = toISODate(endOfMonth);
    remaining = remaining.replace(/이번\s*달/g, "").trim();
  }
  // "다음달" / "다음 달"
  else if (/다음\s*달/.test(remaining)) {
    const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthEnd = new Date(today.getFullYear(), today.getMonth() + 2, 0);
    result.date_from = toISODate(nextMonthStart);
    result.date_to = toISODate(nextMonthEnd);
    remaining = remaining.replace(/다음\s*달/g, "").trim();
  }
  // "N월" (month number)
  else {
    const monthMatch = remaining.match(/(\d{1,2})월/);
    if (monthMatch) {
      const month = parseInt(monthMatch[1], 10);
      if (month >= 1 && month <= 12) {
        let year = today.getFullYear();
        // If the month is in the past, assume next year
        if (month < today.getMonth() + 1) {
          year += 1;
        }
        result.date_from = toISODate(new Date(year, month - 1, 1));
        result.date_to = toISODate(new Date(year, month, 0));
        remaining = remaining.replace(/\d{1,2}월/g, "").trim();
      }
    }
  }

  // 4. Match price expressions
  // "N만원대" → price range around that amount
  const priceRangeMatch = remaining.match(/(\d+)\s*만\s*원\s*대/);
  if (priceRangeMatch) {
    const base = parseInt(priceRangeMatch[1], 10) * 10000;
    result.price_min = base;
    result.price_max = base + 9999;
    remaining = remaining.replace(/\d+\s*만\s*원\s*대/g, "").trim();
  } else {
    // "N만원 이하"
    const maxPriceMatch = remaining.match(/(\d+)\s*만\s*원\s*이하/);
    if (maxPriceMatch) {
      result.price_max = parseInt(maxPriceMatch[1], 10) * 10000;
      remaining = remaining.replace(/\d+\s*만\s*원\s*이하/g, "").trim();
    }
    // "N만원 이상"
    const minPriceMatch = remaining.match(/(\d+)\s*만\s*원\s*이상/);
    if (minPriceMatch) {
      result.price_min = parseInt(minPriceMatch[1], 10) * 10000;
      remaining = remaining.replace(/\d+\s*만\s*원\s*이상/g, "").trim();
    }
    // "N만원~M만원"
    const rangePriceMatch = remaining.match(/(\d+)\s*만\s*원?\s*[~\-]\s*(\d+)\s*만\s*원/);
    if (rangePriceMatch) {
      result.price_min = parseInt(rangePriceMatch[1], 10) * 10000;
      result.price_max = parseInt(rangePriceMatch[2], 10) * 10000;
      remaining = remaining.replace(/\d+\s*만\s*원?\s*[~\-]\s*\d+\s*만\s*원/g, "").trim();
    }
  }

  // 5. Remaining text as query
  remaining = remaining.replace(/\s+/g, " ").trim();
  if (remaining) {
    result.q = remaining;
  }

  return result;
}

export function parsedQueryToTags(parsed: ParsedQuery): { key: string; label: string }[] {
  const tags: { key: string; label: string }[] = [];

  if (parsed.category) {
    const cat = CATEGORIES.find(c => c.slug === parsed.category);
    if (cat) tags.push({ key: "category", label: cat.label });
  }

  if (parsed.city) {
    tags.push({ key: "city", label: parsed.city });
  }

  if (parsed.date_from && parsed.date_to) {
    if (parsed.date_from === parsed.date_to) {
      tags.push({ key: "date", label: parsed.date_from });
    } else {
      tags.push({ key: "date", label: `${parsed.date_from} ~ ${parsed.date_to}` });
    }
  } else if (parsed.date_from) {
    tags.push({ key: "date", label: `${parsed.date_from}~` });
  } else if (parsed.date_to) {
    tags.push({ key: "date", label: `~${parsed.date_to}` });
  }

  if (parsed.price_min !== undefined || parsed.price_max !== undefined) {
    const min = parsed.price_min ? `${(parsed.price_min / 10000).toFixed(0)}만원` : "";
    const max = parsed.price_max ? `${(parsed.price_max / 10000).toFixed(0)}만원` : "";
    if (min && max) {
      tags.push({ key: "price", label: `${min}~${max}` });
    } else if (min) {
      tags.push({ key: "price", label: `${min} 이상` });
    } else if (max) {
      tags.push({ key: "price", label: `${max} 이하` });
    }
  }

  if (parsed.q) {
    tags.push({ key: "q", label: parsed.q });
  }

  return tags;
}
